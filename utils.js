import { Keyring } from '@polkadot/api';

export function sendTransaction(api, call, actor) {
    return new Promise((resolve, reject) => {
      let unsubscribed = false;

      const keyring = new Keyring({ type: 'sr25519' });
      const signer = keyring.addFromUri(actor.seed);
      const unsubscribe = call.signAndSend(signer, ({ status, events, dispatchError }) => {
        const safelyUnsubscribe = () => {
          if (!unsubscribed) {
            unsubscribed = true;
            unsubscribe.then(() => {})
              .catch(error => console.error('Failed to unsubscribe:', error));
          }
        };
        
        // Check for transaction errors
        if (dispatchError) {
          let errout = dispatchError.toString();
          if (dispatchError.isModule) {
            // for module errors, we have the section indexed, lookup
            const decoded = api.registry.findMetaError(dispatchError.asModule);
            const { docs, name, section } = decoded;
            errout = `${name}: ${docs}`;
          }
          safelyUnsubscribe();
          reject(Error(errout));
        }
        // Log and resolve when the transaction is included in a block
        if (status.isInBlock) {
          safelyUnsubscribe();
          resolve(status.asInBlock);
        }
      }).catch((error) => {
        reject(error);
      });
    });
}

// helper: read free balance via system.account
export async function readFreeBalance(api, address) {
  const account = await api.query.system.account(address);
  // polkadot.js returns BN-like; stringify to avoid precision loss, then BigInt
  return BigInt(account.data.free.toString());
}

export async function subnetsAvailable(api) {
  const entries = await api.query.subtensorModule.networksAdded.entries();

  const isTrue = (v) => {
    if (v?.isTrue !== undefined) return v.isTrue;      // Bool codec
    if (typeof v?.valueOf === 'function') return !!v.valueOf(); // Codec → primitive
    return !!v;                                        // plain boolean fallback
  };

  const getNetuid = (storageKey) => {
    const [netuid] = storageKey.args || [];
    if (netuid?.toNumber) return netuid.toNumber();
    return Number(netuid); // fallback
  };

  return entries
    .filter(([, value]) => isTrue(value))
    .map(([key]) => getNetuid(key))
    .sort((a, b) => a - b);
}

function fixedPoint128ToFloatFromHexString(bitsHex) {
  const bits = BigInt(bitsHex);  // Convert string to BigInt

  const MASK_64 = (1n << 64n) - 1n;

  const intPart = bits >> 64n;
  const fracPart = bits & MASK_64;

  return Number(intPart) + Number(fracPart) / 2 ** 64;
}

export async function getAlphaPrice(api, netuid) {
  const sqrtPrice128 = await api.query.swap.alphaSqrtPrice(netuid);
  const sqrtPrice = fixedPoint128ToFloatFromHexString(sqrtPrice128.bits);
  return sqrtPrice * sqrtPrice
}

/**
 * Return a list of validator hotkeys (SS58 strings) for a given netuid.
 * A validator is any uid whose ValidatorPermit[netuid][uid] === true.
 *
 * @param {import('@polkadot/api').ApiPromise} api
 * @param {number|bigint|string} netuid
 * @returns {Promise<string[]>}
 */
export async function getValidatorHotkeys(api, netuid) {
  // Resolve pallet accessors (adjust if your pallet/module name differs)
  const q = api.query;
  const keysAccessor =
    q.subtensorModule?.keys ||
    q.subtensor?.keys ||
    q['subtensorModule']?.keys;

  const permitAccessor =
    q.subtensorModule?.validatorPermit ||
    q.subtensor?.validatorPermit ||
    q['subtensorModule']?.validatorPermit;

  const subnetworkNAccessor =
    q.subtensorModule?.subnetworkN ||
    q.subtensor?.subnetworkN ||
    q['subtensorModule']?.subnetworkN;

  if (!keysAccessor || !permitAccessor) {
    throw new Error('Could not find storage accessors for Keys or ValidatorPermit (check pallet path).');
  }

  // 1) Read ValidatorPermit[netuid] -> Vec<bool>
  const permitsRaw = await permitAccessor(netuid);

  // Normalize to a JS boolean array
  let permits;
  if (typeof permitsRaw.toArray === 'function') {
    permits = permitsRaw.toArray().map(b => !!b.valueOf());
  } else {
    // fallback via JSON
    permits = (permitsRaw?.toJSON?.() || []).map(Boolean);
  }

  // If the vector is empty, optionally fall back to subnetwork size
  if (permits.length === 0 && subnetworkNAccessor) {
    const nRaw = await subnetworkNAccessor(netuid);
    const n = Number(nRaw?.toString?.() ?? nRaw);
    if (Number.isFinite(n) && n > 0) {
      // assume no permissions (all false) when vector is missing
      permits = new Array(n).fill(false);
    }
  }

  // 2) Fetch Keys[netuid, uid] for each uid with permit === true
  const indices = [];
  for (let uid = 0; uid < permits.length; uid++) {
    if (permits[uid] === true) indices.push(uid);
  }
  if (indices.length === 0) return [];

  const hotkeysRaw = await Promise.all(
    indices.map(uid => keysAccessor(netuid, uid))
  );

  // 3) Convert AccountId -> SS58 string and filter any empty/missing
  const hotkeys = hotkeysRaw
    .map(h => (h && h.toString ? h.toString() : String(h || '')))
    .filter(addr => addr && addr !== 'null' && addr !== 'undefined');

  return hotkeys;
}

export function randInt(min, max) {
  // inclusive [min, max]
  if (typeof min === 'bigint' || typeof max === 'bigint') {
    const a = BigInt(min), b = BigInt(max);
    if (b < a) throw new Error('max < min');
    const range = b - a + 1n;

    // If the range fits safely in Number, sample with Math.random and upcast.
    if (range <= 9007199254740991n) { // Number.MAX_SAFE_INTEGER
      const offset = BigInt(Math.floor(Math.random() * Number(range)));
      return a + offset; // BigInt
    }

    // Fallback: rejection sampling with 53-bit chunks
    const bits = range.toString(2).length;
    // generate random BigInt < 2^bits until < range
    while (true) {
      let rnd = 0n;
      let produced = 0;
      while (produced < bits) {
        const chunk = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)); // 53 bits
        rnd = (rnd << 53n) + chunk;
        produced += 53;
      }
      rnd &= (1n << BigInt(bits)) - 1n;
      if (rnd < range) return a + rnd; // BigInt
    }
  } else {
    const a = Number(min), b = Number(max);
    if (b < a) throw new Error('max < min');
    return Math.floor(Math.random() * (b - a + 1)) + a; // Number
  }
}

function i96f32ToFloatFromHexString(bitsHex) {
  const bits = BigInt(bitsHex);  // Convert string to BigInt

  const MASK_96 = (1n << 96n) - 1n;

  const intPart = bits >> 32n;
  const fracPart = bits & MASK_96;

  return Number(intPart) + Number(fracPart) / 2 ** 32;
}

// Helpers ---------------------------------------------------------

// Convert a polkadot.js numeric (u128/FixedU128 inner) to BigInt
const toBI = (x) =>
  (typeof x === 'bigint') ? x
  : (x && typeof x.toBigInt === 'function') ? x.toBigInt()
  : (x && typeof x.toString === 'function') ? BigInt(x.toString())
  : BigInt(x); // last resort (handles "0x..." or decimal strings)

/**
 * Read FixedU128 "bits" into a BigInt scaled by 1e18.
 * Works with { bits: <BN|BigInt|string> } returned by polkadot.js.
 */
const fixedU128BitsToBI = (fixedU128) => toBI(fixedU128.bits);

// ---------------------------------------------------------------

/**
 * Compute stake = hotkeyAlpha * alphaShare / totalHotkeyShares
 * using full-precision BigInt math. Returns BigInt.
 */
export async function getStake(api, netuid, coldkey, hotkey) {
  // alpha(hotkey, coldkey, netuid): FixedU128
  const alphaShareFixed = await api.query.subtensorModule.alpha(hotkey, coldkey, netuid);
  const alphaShareBI = fixedU128BitsToBI(alphaShareFixed); // scaled (1e18)

  // totalHotkeyShares(hotkey, netuid): FixedU128
  const totalSharesFixed = await api.query.subtensorModule.totalHotkeyShares(hotkey, netuid);
  const totalSharesBI = fixedU128BitsToBI(totalSharesFixed); // scaled (1e18)

  // totalHotkeyAlpha(hotkey, netuid): u128
  const hotkeyAlpha = await api.query.subtensorModule.totalHotkeyAlpha(hotkey, netuid);
  const hotkeyAlphaBI = toBI(hotkeyAlpha); // plain u128, not scaled

  if (totalSharesBI === 0n) return 0n;

  // Ratio of two FixedU128 cancels the scale, so we can do:
  // stake = hotkeyAlpha * alphaShare / totalShares   (all as BigInt)
  const stakeBI = (hotkeyAlphaBI * alphaShareBI) / totalSharesBI;

  return stakeBI; // BigInt
}

// amount / price  (amount is BigInt, price is decimal string or number)
export function divAmountByPrice(amountBI, alphaPrice) {
  const priceScaled = BigInt(parseInt(alphaPrice * 10 ** 9));
  return amountBI / priceScaled * 1_000_000_000n;
}

// amount * price  (amount is BigInt, price is decimal string or number)
export function mulAmountByPrice(amountBI, alphaPrice) {
  const priceScaled = BigInt(parseInt(alphaPrice * 10 ** 9));
  return amountBI * priceScaled / 1_000_000_000n;
}

/** Approx-equal for BigInt using absolute epsilon. */
export function approxEqualAbs(a, b, epsilon) {
  if (typeof a !== 'bigint' || typeof b !== 'bigint' || typeof epsilon !== 'bigint') {
    throw new TypeError('Use BigInt for a, b, and epsilon');
  }
  const diff = a >= b ? a - b : b - a;
  return diff <= epsilon;
}

/**
 * Return registry coldkeys that currently have non-zero Alpha on the given netuid.
 * @param {ApiPromise} api
 * @param {Record<string, {address?: string}>} registry
 * @param {number} netuid
 * @returns {Promise<string[]>} list of coldkey SS58 addresses
 */
export async function getRegistryColdkeysWithAlpha(api, registry, netuid) {
  // Collect candidate coldkeys from registry
  const coldkeys = Object.values(registry)
    .map(v => v?.address)
    .filter(Boolean);

  // zero check that works for U64F64/Fixed types returned by polkadot.js
  const isZero = (v) =>
    (v && typeof v.isZero === 'function') ? v.isZero() :
    v?.toString?.() === '0';

  const out = [];

  for (const cold of coldkeys) {
    // 1) All hotkeys that ever staked to this coldkey
    const hotVec = await api.query.subtensorModule.stakingHotkeys(cold);
    const hotAddrs = hotVec.map(h => h.toString());
    if (hotAddrs.length === 0) continue;

    // 2) Read stakes
    const stakes = await Promise.all(
      hotAddrs.map(hot => getStake(api, netuid, cold, hot))
    );

    // 3) If any non-zero, include this coldkey and move on
    if (stakes.some(a => !isZero(a))) {
      out.push(cold);
    }
  }

  return out;
}

/**
 * Hotkeys that a given coldkey currently stakes to on a specific netuid.
 * Uses stakingHotkeys(cold) as candidates and alpha.multi([[hot,cold,netuid],...]).
 *
 * @param {ApiPromise} api
 * @param {string} coldkey  SS58 string
 * @param {number} netuid
 * @returns {Promise<string[]>} SS58 hotkey addresses with non-zero alpha
 */
export async function getHotkeysStakedByColdkey(api, coldkey, netuid) {
  // candidates: ever-staked hotkeys for this coldkey
  const hotVec = await api.query.subtensorModule.stakingHotkeys(coldkey);
  const hotAddrs = hotVec.map(h => h.toString());
  if (hotAddrs.length === 0) return [];

  // batch read Alpha(hot, cold, netuid)
  const stakes = await Promise.all(
    hotAddrs.map(hot => getStake(api, netuid, coldkey, hot))
  );

  // keep non-zero
  const isZero = (v) =>
    (v && typeof v.isZero === 'function') ? v.isZero() :
    v?.toString?.() === '0';

  const active = [];
  for (let i = 0; i < hotAddrs.length; i++) {
    if (!isZero(stakes[i])) active.push(hotAddrs[i]);
  }
  return active;
}


import { Keyring } from '@polkadot/api';
import BigNumber from "bignumber.js";

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

export function fixedI96F32ToFloatFromHexString(bitsHex) {
  const bits = BigInt(bitsHex);  // Convert string to BigInt

  const MASK_96 = (1n << 96n) - 1n;

  const intPart = bits >> 32n;
  const fracPart = bits & MASK_96;

  return Number(intPart) + Number(fracPart) / 2 ** 32;
}

export function fixedU64F64ToFloatFromHexString(bitsHex) {
  const bits = BigInt(bitsHex);  // Convert string to BigInt

  const MASK_64 = (1n << 64n) - 1n;

  const intPart = bits >> 64n;
  const fracPart = bits & MASK_64;

  return Number(intPart) + Number(fracPart) / 2 ** 64;
}

export function fixedU64F64ToBigNumber(bitsHex) {
  bitsHex = bitsHex.toHex();
  const hex = bitsHex.startsWith("0x") ? bitsHex.slice(2) : bitsHex;
  const bits = new BigNumber(hex, 16);

  const TWO_64 = new BigNumber(2).pow(64);
  const intPart  = bits.dividedToIntegerBy(TWO_64);
  const fracPart = bits.mod(TWO_64);

  return intPart.plus(fracPart.div(TWO_64));
}

export function fixedU96F32ToBigNumber(bitsHex) {
  bitsHex = bitsHex.toHex();
  const hex = bitsHex.startsWith("0x") ? bitsHex.slice(2) : bitsHex;
  const bits = new BigNumber(hex, 16);

  const TWO_32 = new BigNumber(2).pow(32);
  const intPart  = bits.dividedToIntegerBy(TWO_32);
  const fracPart = bits.mod(TWO_32);

  return intPart.plus(fracPart.div(TWO_32));
}

/**
 * Compute stake = hotkeyAlpha * alphaShare / totalHotkeyShares
 * using full-precision BigInt math. Returns BigInt.
 */
export async function getStake(api, netuid, coldkey, hotkey) {
  const alphaShare128 = (await api.query.subtensorModule.alpha(hotkey, coldkey, netuid));
  const alphaShare = fixedU64F64ToFloatFromHexString(alphaShare128.bits);

  const hotkeyAlpha = (await api.query.subtensorModule.totalHotkeyAlpha(hotkey, netuid));

  const totalHotkeyShares128 = (await api.query.subtensorModule.totalHotkeyShares(hotkey, netuid));
  const totalHotkeyShares = fixedU64F64ToFloatFromHexString(totalHotkeyShares128.bits);

  let stake = 0;
  if (totalHotkeyShares != 0) {
    stake = parseInt(alphaShare * hotkeyAlpha / totalHotkeyShares);
  }

  return stake;
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

/** Approx-equal for any numeric type including BigInt using absolute epsilon. */
export function approxEqualAbs(a, b, epsilon) {
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

/**
 * Approximate equality with same-type args:
 *  - number:   classic relative tolerance (rel is a Number, e.g. 1e-6)
 *  - BigInt:   rel is an integer numerator over a fixed DEN = 1e12 (i.e., rel=1_000_000n ≙ 1e-6)
 *  - BigNumber (bignumber.js): rel is a BigNumber (e.g., new BigNumber("1e-6"))
 */
export function approxEqRel(a, b, rel) {
  const tA = typeof a;
  const tB = typeof b;
  const tR = typeof rel;

  // ---- Type gate: all same kind ----
  const isBN = (x) => x instanceof BigNumber || x?.isBigNumber === true;
  const sameNumber   = tA === "number" && tB === "number" && tR === "number";
  const sameBigInt   = tA === "bigint" && tB === "bigint" && tR === "bigint";
  const sameBigNum   = isBN(a) && isBN(b) && isBN(rel);

  if (!(sameNumber || sameBigInt || sameBigNum)) {
    throw new TypeError("a, b, and rel must be the same numeric type (number, bigint, or BigNumber).");
  }

  // ---- Number path ----
  if (sameNumber) {
    const diff  = Math.abs(a - b);
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    return diff / scale <= rel;
  }

  // ---- BigInt path ----
  // Interpret rel as a fixed-point ratio with denominator DEN = 1e12 (integer only).
  // Example: rel = 1_000_000n means 1e-6 tolerance.
  if (sameBigInt) {
    const abs  = (n) => (n >= 0n ? n : -n);
    const max2 = (x, y) => (x >= y ? x : y);

    const diff  = abs(a - b);
    const scale = max2(max2(abs(a), abs(b)), 1n);

    const DEN = 1_000_000_000_000n; // 1e12 resolution
    // Compare diff/scale <= rel/DEN  ->  diff * DEN <= scale * rel
    return diff * DEN <= scale * rel;
  }

  // ---- BigNumber (bignumber.js) path ----
  {
    const A = a; const B = b; const R = rel;
    const diff  = A.minus(B).abs();
    const scale = BigNumber.max(A.abs(), B.abs(), new BigNumber(1));
    return diff.lte(scale.times(R));
  }
}


export async function getPendingEmissionAt(api, blockNumber) {
  const apiAt = await getApiAtBlock(api, blockNumber);
  const entries = await apiAt.query.subtensorModule.pendingEmission.entries();

  return entries.map(([key, val]) => {
    const netuid = key.args[0].toNumber();       // (netuid)
    const valueString = val.toString();          // precise decimal string (preferred)
    const valueNumber = Number(valueString);     // JS number (may lose precision)
    return { netuid, valueNumber };
  });
}

export async function getPendingServerEmissionAt(api, blockNumber) {
  const apiAt = await getApiAtBlock(api, blockNumber);
  const entries = await apiAt.query.subtensorModule.pendingServerEmission.entries();

  return entries.map(([key, val]) => {
    const netuid = key.args[0].toNumber();       // (netuid)
    const valueString = val.toString();          // precise decimal string (preferred)
    const valueNumber = Number(valueString);     // JS number (may lose precision)
    return { netuid, valueNumber };
  });
}

export async function getPendingValidatorEmissionAt(api, blockNumber) {
  const apiAt = await getApiAtBlock(api, blockNumber);
  const entries = await apiAt.query.subtensorModule.pendingValidatorEmission.entries();

  return entries.map(([key, val]) => {
    const netuid = key.args[0].toNumber();       // (netuid)
    const valueString = val.toString();          // precise decimal string (preferred)
    const valueNumber = Number(valueString);     // JS number (may lose precision)
    return { netuid, valueNumber };
  });
}

export async function getPendingRootAlphaDivsAt(api, blockNumber) {
  const apiAt = await getApiAtBlock(api, blockNumber);
  const entries = await apiAt.query.subtensorModule.pendingRootAlphaDivs.entries();

  return entries.map(([key, val]) => {
    const netuid = key.args[0].toNumber();   // (netuid)
    const valueString = val.toString();      // precise decimal string (preferred)
    const valueNumber = Number(valueString); // JS number (may lose precision)
    return { netuid, valueNumber };
  });
}

// Helper: get an api handle at a specific block (or latest)
async function getApiAtBlock(api, blockNumber) {
  if (blockNumber === undefined || blockNumber === null) return api;
  const hash = await api.rpc.chain.getBlockHash(blockNumber);
  return api.at(hash);
}

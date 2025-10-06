import { approxEqualAbs, fixedU64F64ToFloatFromHexString, subnetsAvailable } from './utils.js'

export async function checkKeysUidsConstraints(api) {
  // ---------- helpers ----------
  const toNum = (x) => (typeof x?.toNumber === 'function' ? x.toNumber() : Number(x));
  const toStr = (x) => (x?.toString ? x.toString() : String(x));
  const rangeArray = (n) => Array.from({ length: n }, (_, i) => i);
  const sEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  let overallOk = true;
  const err = (msg) => { console.log(`Constraint error: ${msg}`); overallOk = false; };

  const getUidsEntries = async (netuid) => {
    try {
      const entries = await api.query.subtensorModule.uids.entries(netuid);
      return entries.map(([k, v]) => {
        const hot = toStr(k.args[1]);
        const uid = toNum(v.unwrap ? v.unwrap() : v);
        return { hot, uid };
      });
    } catch (e) {
      err(`failed to read Uids entries for netuid ${netuid}: ${e?.message ?? e}`);
      return [];
    }
  };

  const getKeysEntries = async (netuid) => {
    try {
      const entries = await api.query.subtensorModule.keys.entries(netuid);
      return entries.map(([k, v]) => {
        const uid = toNum(k.args[1]);
        const hot = toStr(v);
        return { uid, hot };
      });
    } catch (e) {
      err(`failed to read Keys entries for netuid ${netuid}: ${e?.message ?? e}`);
      return [];
    }
  };

  async function countIsNetworkMemberForNetuid(netuid) {
    const entries = await api.query.subtensorModule.isNetworkMember.entries();
    let count = 0;
    for (const [k, v] of entries) {
      // DoubleMap args are [hot, netuid]
      const uidArg = k.args[1].toNumber();
      const isTrue = v === true || v?.isTrue === true;
      if (uidArg === netuid && isTrue) count++;
    }
    return count;
  }

  const listHotForNetDoubleMap = async (storage, netuid) => {
    try {
      const keys = await storage.keys(netuid); // args: [netuid, hot]
      return new Set(keys.map((k) => toStr(k.args[1])));
    } catch (e) {
      err(`failed to list ${storage.creator?.meta?.name?.toString?.() ?? 'double-map'} for netuid ${netuid}: ${e?.message ?? e}`);
      return new Set();
    }
  };

  async function ownerConsistencyOk(hot, netuid) {
    try {
      const cold = toStr(await api.query.subtensorModule.owner(hot));
      const owned = await api.query.subtensorModule.ownedHotkeys(cold);
      const list = owned.map((h) => toStr(h));
      if (!list.includes(hot)) {
        err(`8.1 OwnedHotkeys(${cold}) does not contain hotkey ${hot} (netuid ${netuid})`);
        return false;
      }
      const owners = await Promise.all(
        list.map(async (h) => [h, await api.query.subtensorModule.owner(h)])
      ); // owners: Array<[hot, owner]>
      const allSame = owners.every(([h, c]) => {
        if (toStr(c) !== cold) {
          err(`8.2 Owner() mismatch: OwnedHotkeys(${cold}) contains ${toStr(h)}, but its owner is ${toStr(c)} (netuid ${netuid})`);
        }
        return (toStr(c) === cold)
      });
      if (!allSame) {
        return false;
      }
      return true;
    } catch (e) {
      err(`8 Owner/OwnedHotkeys query failed for hotkey ${hot} (netuid ${netuid}): ${e?.message ?? e}`);
      return false;
    }
  }

  // Get all netuids
  const netuids = await subnetsAvailable(api);
  if (netuids.length === 0) return true; // nothing to check

  // ---------- per-netuid validation ----------
  for (const netuid of netuids) {
    let N = 0, maxAllowed = 0;
    try {
      N = toNum(await api.query.subtensorModule.subnetworkN(netuid));
      maxAllowed = toNum(await api.query.subtensorModule.maxAllowedUids(netuid));
    } catch (e) {
      err(`failed to read N/MaxAllowed for netuid ${netuid}: ${e?.message ?? e}`);
      overallOk = false;
      continue;
    }

    // 7. SubnetworkN <= MaxAllowedUids
    if (!(N <= maxAllowed)) {
      err(`7 SubnetworkN(${netuid})=${N} exceeds MaxAllowedUids(${netuid})=${maxAllowed}`);
    }

    const keys = await getKeysEntries(netuid); // [{uid, hot}]
    const uids = await getUidsEntries(netuid); // [{hot, uid}]

    // console.log(`netuid = ${netuid}, uids = ${JSON.stringify(uids)}`);

    const uidsFromKeys = new Set(keys.map((e) => e.uid));
    const uidsFromUids = new Set(uids.map((e) => e.uid));
    const hotsFromKeys = new Set(keys.map((e) => e.hot));
    const hotsFromUids = new Set(uids.map((e) => e.hot));
    if (!sEqual(hotsFromKeys, hotsFromUids)) {
      err(`Hotkey sets in Keys and Uids are different (netuid ${netuid})`);
    }
    const HKSet = new Set([...hotsFromKeys]);

    // 1. Both contain exactly N distinct UIDs
    if (uidsFromKeys.size !== N) {
      err(`1 Keys has ${uidsFromKeys.size} distinct UIDs, expected ${N} (netuid ${netuid})`);
    }
    if (uidsFromUids.size !== N) {
      err(`1 Uids has ${uidsFromUids.size} distinct UIDs, expected ${N} (netuid ${netuid})`);
    }

    // 2. UIDs are 0..N-1 (no gaps)
    const expected = new Set(rangeArray(N));
    if (!sEqual(uidsFromKeys, expected)) {
      err(`2 Keys UID set != 0..${N - 1} (netuid ${netuid})`);
    }
    if (!sEqual(uidsFromUids, expected)) {
      err(`2 Uids UID set != 0..${N - 1} (netuid ${netuid})`);
    }

    // 3. No duplicate values in Uids (entries count == N)
    if (uids.length !== N) {
      err(`3 Uids has ${uids.length} entries, expected ${N} (duplicates or missing) (netuid ${netuid})`);
    }

    // 4. No duplicate values in Keys (no two uids map to same hotkey)
    if (new Set(keys.map((e) => e.hot)).size !== keys.length) {
      err(`4 Keys has duplicate hotkeys (size ${new Set(keys.map((e) => e.hot)).size} vs entries ${keys.length}) (netuid ${netuid})`);
    }

    // 5. Keys -> Uids exact inverse
    {
      const uidsMap = new Map(uids.map((e) => [e.hot, e.uid])); // hot -> uid
      for (const { uid, hot } of keys) {
        const u = uidsMap.get(hot);
        if (u === undefined) {
          err(`5 Keys(${netuid}, ${uid}) -> ${hot} has no matching Uids(${netuid}, ${hot})`);
        } else if (u !== uid) {
          err(`5 Keys(${netuid}, ${uid}) -> ${hot} but Uids(${netuid}, ${hot}) -> ${u} (mismatch)`);
        }
      }
    }

    // 6. Uids -> Keys exact inverse
    {
      const keysMap = new Map(keys.map((e) => [e.uid, e.hot])); // uid -> hot
      for (const { hot, uid } of uids) {
        const h = keysMap.get(uid);
        if (h === undefined) {
          err(`6 Uids(${netuid}, ${hot}) -> ${uid} has no matching Keys(${netuid}, ${uid})`);
        } else if (h !== hot) {
          err(`6 Uids(${netuid}, ${hot}) -> ${uid} but Keys(${netuid}, ${uid}) -> ${h} (mismatch)`);
        }
      }
    }

    // 8 / 8.1 / 8.2 Owner/OwnedHotkeys linkage for every hot in HKSet
    for (const hot of HKSet) {
      const ok = await ownerConsistencyOk(hot, netuid);
      if (!ok) overallOk = false; // ownerConsistencyOk already logged details
    }

    // 9.1 IsNetworkMember == HKSet
    {
      // All HKSet members must be true
      try {
        const memChecks = await Promise.all(
          [...HKSet].map((hot) => api.query.subtensorModule.isNetworkMember(hot, netuid))
        );
        const allTrue = memChecks.every((v) => v === true || v?.isTrue === true);
        if (!allTrue) {
          err(`9.1 Some HKSet hotkeys are not IsNetworkMember(*, ${netuid}) == true`);
        }
      } catch (e) {
        err(`9.1 failed querying IsNetworkMember(*, ${netuid}): ${e?.message ?? e}`);
      }

      // No extras (cardinality match)
      const memberCount = await countIsNetworkMemberForNetuid(netuid);
      if (memberCount !== HKSet.size) {
        err(`9.1 IsNetworkMember count(${memberCount}) != HKSet size(${HKSet.size}) (netuid ${netuid})`);
      }
    }

    // 9.2 Axons ⊆ HKSet
    {
      const axonHots = await listHotForNetDoubleMap(api.query.subtensorModule.axons, netuid);
      for (const hot of axonHots) if (!HKSet.has(hot)) err(`9.2 Axons contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
    }

    // 9.3 NeuronCertificates ⊆ HKSet
    {
      const certHots = await listHotForNetDoubleMap(api.query.subtensorModule.neuronCertificates, netuid);
      for (const hot of certHots) if (!HKSet.has(hot)) err(`9.3 NeuronCertificates contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
    }

    // 9.4 Prometheus ⊆ HKSet
    {
      const promHots = await listHotForNetDoubleMap(api.query.subtensorModule.prometheus, netuid);
      for (const hot of promHots) if (!HKSet.has(hot)) err(`9.4 Prometheus contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
    }
  }

  return overallOk;
}

/**
 * Check staking-related invariants:
 * 1) sum_h(TotalHotkeyAlpha(h, n)) + PendingEmission(n) == SubnetAlphaOut(n)
 * 2) For every (h, c, n) in Alpha: StakingHotkeys(c) includes h
 * 3) For every (h, n): sum_c Alpha(h, c, n) == TotalHotkeyShares(h, n)
 *
 * Logs every violation and returns true iff ALL hold.
 */
export async function checkStakingConstraints(api) {
  const toNum = (x) => (typeof x?.toNumber === "function" ? x.toNumber() : Number(x));
  const toStr = (x) => (x?.toString ? x.toString() : String(x));

  let overallOk = true;
  const err = (m) => { console.log(`Constraint error: ${m}`); overallOk = false; };

  // ---------- netuids ----------
  let netuids = await subnetsAvailable(api);
  if (netuids.length === 0) return true;

  // ---------- (1) sum(TotalHotkeyAlpha(*, n)) + PendingEmission(n) == SubnetAlphaOut(n) ----------
  const thaEntries = await api.query.subtensorModule.totalHotkeyAlpha.entries();
  const sumThaByNet = new Map(); // n -> BigInt
  for (const [k, v] of thaEntries) {
    const n = toNum(k.args[1]); // args: [hot, netuid]
    const prev = sumThaByNet.get(n) ?? 0n;
    sumThaByNet.set(n, prev + BigInt(v));
  }

  for (const n of netuids) {
    const sumTha = sumThaByNet.get(n) ?? 0n;
    const pending = BigInt(await api.query.subtensorModule.pendingEmission(n));
    const out = BigInt(await api.query.subtensorModule.subnetAlphaOut(n));
    if (sumTha + pending !== out) {
      err(`1 sum(TotalHotkeyAlpha(*, ${n})) + PendingEmission(${n}) != SubnetAlphaOut(${n}) (sum=${sumTha} pending=${pending} out=${out})`);
    }
  }

  // ---------- (2) Alpha(h,c,n) => StakingHotkeys(c) includes h; and (3) sum Alpha == TotalHotkeyShares ----------
  const pageSize = 1000;
  let startKey;
  const coldCache = new Map(); // cold -> Set(hot)
  const sumAlphaByNetHot = new Map(); // `${n}|${hot}` -> raw BigInt
  const hotPerNet = new Map(); // n -> Set(hot)

  for (;;) {
    const pageKeys = await api.query.subtensorModule.alpha.keysPaged({ args: [], pageSize, startKey });
    if (pageKeys.length === 0) break;

    const tuples = pageKeys.map((k) => [toStr(k.args[0]), toStr(k.args[1]), toNum(k.args[2])]); // [hot,cold,n]
    const values = await api.query.subtensorModule.alpha.multi(tuples);

    for (let i = 0; i < tuples.length; i++) {
      const [hot, cold, n] = tuples[i];

      const alphaShare128 = values[i];
      const alphaShare = fixedU64F64ToFloatFromHexString(alphaShare128.bits);

      // (2) stakingHotkeys(cold) must include hot
      let set = coldCache.get(cold);
      if (!set) {
        const vec = await api.query.subtensorModule.stakingHotkeys(cold);
        set = new Set(vec.map((h) => toStr(h)));
        coldCache.set(cold, set);
      }
      if ((!set.has(hot)) && (alphaShare != 0)) {
        err(`2 StakingHotkeys(${cold}) does not include hotkey ${hot} (present in Alpha with netuid ${n})`);
      }

      // (3) accumulate
      const key = `${n}|${hot}`;
      const prev = sumAlphaByNetHot.get(key) ?? 0;
      sumAlphaByNetHot.set(key, prev + alphaShare);

      if (!hotPerNet.has(n)) hotPerNet.set(n, new Set());
      hotPerNet.get(n).add(hot);
    }

    startKey = pageKeys[pageKeys.length - 1];
  }

  // For each (n, hot) seen, compare sum Alpha(h,*,n) with TotalHotkeyShares(h,n)
  for (const [n, hotSet] of hotPerNet.entries()) {
    const hotList = [...hotSet];
    const keys = hotList.map((h) => [h, n]);
    const totals = await api.query.subtensorModule.totalHotkeyShares.multi(keys);
    for (let i = 0; i < hotList.length; i++) {
      const h = hotList[i];
      const expected = sumAlphaByNetHot.get(`${n}|${h}`) ?? 0;
      const totalHotkeyShares128 = totals[i];
      const actualTotalHotkeyShares = fixedU64F64ToFloatFromHexString(totalHotkeyShares128.bits);
      if (!approxEqualAbs(actualTotalHotkeyShares, expected, expected / 1000)) {
        err(`3 TotalHotkeyShares(${h}, ${n}) != sum Alpha(${h}, *, ${n}) (actual=${actualTotalHotkeyShares} expected=${expected})`);
      }
    }
  }

  return overallOk;
}

/**
 * Check Weights and Bonds storage constraints
 * 
 * Validates that the Weights and Bonds double maps maintain proper structure:
 * 
 * 10.1 Map Height Constraint: 
 *      - Number of entries in Weights[netuid_index] <= SubnetworkN[netuid]
 *      - Number of entries in Bonds[netuid_index] <= SubnetworkN[netuid]
 * 
 * 10.2 Valid NetUid Index and UID Keys:
 *      - All UIDs used as map keys must be in range [0, SubnetworkN-1]
 * 
 * 10.3 No Duplicate Target UIDs:
 *      - Each weights/bonds vector has unique target UIDs (no duplicates)
 * 
 * 10.4 Valid Target UID Range:
 *      - All target UIDs in weight/bond pairs are in range [0, SubnetworkN-1]
 * 
 * 10.5 MaxWeightsLimit Constraint:
 *      - Length of weights vector <= MaxWeightsLimit[netuid]
 * 
 * 10.6 Non-negative Values:
 *      - All weights and bonds are non-negative
 * 
 * 10.7 Mechanism Count Bounds:
 *      - MechanismCountCurrent[netuid] <= MaxMechanismCount
 * 
 * These constraints ensure that:
 * - Weights and bonds only reference valid, existing neurons
 * - No duplicate or invalid target UIDs exist
 * - Storage doesn't exceed configured limits
 * - All values are properly bounded and valid
 * 
 * @param {ApiPromise} api - Connected Polkadot API instance
 * @returns {Promise<boolean>} true if all constraints pass, false otherwise
 */
export async function checkWeightsBondsConstraints(api) {
  // ---------- helpers ----------
  const toNum = (x) => (typeof x?.toNumber === 'function' ? x.toNumber() : Number(x));
  const toStr = (x) => (x?.toString ? x.toString() : String(x));

  let overallOk = true;
  const err = (msg) => { console.log(`Weights/Bonds constraint error: ${msg}`); overallOk = false; };

  // Constants from subtensor/pallets/subtensor/src/subnets/mechanism.rs
  const GLOBAL_MAX_SUBNET_COUNT = 4096;

  const getMechanismStorageIndex = (netuid, mecid) => {
    // Formula: storage_index = netuid + sub_id * GLOBAL_MAX_SUBNET_COUNT
    // This matches the Rust implementation
    return netuid + (mecid * GLOBAL_MAX_SUBNET_COUNT);
  };

  const getNetuidFromIndex = (storageIndex) => {
    return storageIndex % GLOBAL_MAX_SUBNET_COUNT;
  };

  const getWeightsEntries = async (netuidIndex) => {
    try {
      const entries = await api.query.subtensorModule.weights.entries(netuidIndex);
      return entries.map(([k, v]) => {
        const uid = toNum(k.args[1]);
        const weightsVec = v.map((pair) => {
          // Assuming pair is a tuple [target_uid, weight]
          const target = toNum(pair[0]);
          const weight = toNum(pair[1]);
          return { target, weight };
        });
        return { uid, weights: weightsVec };
      });
    } catch (e) {
      err(`failed to read Weights entries for netuid_index ${netuidIndex}: ${e?.message ?? e}`);
      return [];
    }
  };

  const getBondsEntries = async (netuidIndex) => {
    try {
      const entries = await api.query.subtensorModule.bonds.entries(netuidIndex);
      return entries.map(([k, v]) => {
        const uid = toNum(k.args[1]);
        const bondsVec = v.map((pair) => {
          const target = toNum(pair[0]);
          const bond = toNum(pair[1]);
          return { target, bond };
        });
        return { uid, bonds: bondsVec };
      });
    } catch (e) {
      err(`failed to read Bonds entries for netuid_index ${netuidIndex}: ${e?.message ?? e}`);
      return [];
    }
  };

  // Get all netuids
  const netuids = await subnetsAvailable(api);
  if (netuids.length === 0) return true; // nothing to check

  // ---------- per-netuid validation ----------
  for (const netuid of netuids) {
    let N = 0, mechanismCount = 1;
    try {
      N = toNum(await api.query.subtensorModule.subnetworkN(netuid));
      // Try to get mechanism count, but if it fails, default to 1
      try {
        const mecCount = await api.query.subtensorModule.mechanismCountCurrent(netuid);
        if (mecCount) {
          mechanismCount = toNum(mecCount);
        }
      } catch (e) {
        // mechanismCountCurrent might not exist, default to 1
        mechanismCount = 1;
      }
    } catch (e) {
      err(`failed to read SubnetworkN for netuid ${netuid}: ${e?.message ?? e}`);
      overallOk = false;
      continue;
    }

    // Check constraints for each mechanism in this subnet
    for (let mecid = 0; mecid < mechanismCount; mecid++) {
      const netuidIndex = getMechanismStorageIndex(netuid, mecid);

      // Get weights and bonds for this mechanism
      const weightsEntries = await getWeightsEntries(netuidIndex);
      const bondsEntries = await getBondsEntries(netuidIndex);

      // 10.1 Map Height Constraint: number of entries <= SubnetworkN
      if (weightsEntries.length > N) {
        err(`10.1 Weights[${netuidIndex}] has ${weightsEntries.length} entries, exceeds SubnetworkN=${N} (netuid ${netuid}, mecid ${mecid})`);
      }
      if (bondsEntries.length > N) {
        err(`10.1 Bonds[${netuidIndex}] has ${bondsEntries.length} entries, exceeds SubnetworkN=${N} (netuid ${netuid}, mecid ${mecid})`);
      }

      // 10.2 Valid UID range for map keys
      for (const { uid } of weightsEntries) {
        if (uid < 0 || uid >= N) {
          err(`10.2 Weights[${netuidIndex}] contains invalid UID ${uid}, expected 0..${N - 1} (netuid ${netuid}, mecid ${mecid})`);
        }
      }
      for (const { uid } of bondsEntries) {
        if (uid < 0 || uid >= N) {
          err(`10.2 Bonds[${netuidIndex}] contains invalid UID ${uid}, expected 0..${N - 1} (netuid ${netuid}, mecid ${mecid})`);
        }
      }

      // 10.3 Row constraints: No duplicate target UIDs
      for (const { uid, weights } of weightsEntries) {
        const targets = weights.map((w) => w.target);
        const uniqueTargets = new Set(targets);
        if (targets.length !== uniqueTargets.size) {
          err(`10.3 Weights[${netuidIndex}][${uid}] has duplicate target UIDs (netuid ${netuid}, mecid ${mecid})`);
        }
      }
      for (const { uid, bonds } of bondsEntries) {
        const targets = bonds.map((b) => b.target);
        const uniqueTargets = new Set(targets);
        if (targets.length !== uniqueTargets.size) {
          err(`10.3 Bonds[${netuidIndex}][${uid}] has duplicate target UIDs (netuid ${netuid}, mecid ${mecid})`);
        }
      }

      // 10.4 Row constraints: Valid target UID range
      for (const { uid, weights } of weightsEntries) {
        for (const { target } of weights) {
          if (target < 0 || target >= N) {
            err(`10.4 Weights[${netuidIndex}][${uid}] contains invalid target UID ${target}, expected 0..${N - 1} (netuid ${netuid}, mecid ${mecid})`);
          }
        }
      }
      for (const { uid, bonds } of bondsEntries) {
        for (const { target } of bonds) {
          if (target < 0 || target >= N) {
            err(`10.4 Bonds[${netuidIndex}][${uid}] contains invalid target UID ${target}, expected 0..${N - 1} (netuid ${netuid}, mecid ${mecid})`);
          }
        }
      }

      // 10.5 Check MaxWeightsLimit constraint (if available)
      try {
        const maxWeightsLimit = toNum(await api.query.subtensorModule.maxWeightsLimit(netuid));
        for (const { uid, weights } of weightsEntries) {
          if (weights.length > maxWeightsLimit) {
            err(`10.5 Weights[${netuidIndex}][${uid}] has ${weights.length} entries, exceeds MaxWeightsLimit=${maxWeightsLimit} (netuid ${netuid}, mecid ${mecid})`);
          }
        }
      } catch (e) {
        // MaxWeightsLimit might not be queryable or might not exist
        // This is not a critical error, so we skip it
      }

      // 10.6 Weights and bonds should be non-negative (if represented as unsigned, this is implicit)
      // This check is redundant if the storage type is u16, but we include it for completeness
      for (const { uid, weights } of weightsEntries) {
        for (const { weight } of weights) {
          if (weight < 0) {
            err(`10.6 Weights[${netuidIndex}][${uid}] contains negative weight ${weight} (netuid ${netuid}, mecid ${mecid})`);
          }
        }
      }
      for (const { uid, bonds } of bondsEntries) {
        for (const { bond } of bonds) {
          if (bond < 0) {
            err(`10.6 Bonds[${netuidIndex}][${uid}] contains negative bond ${bond} (netuid ${netuid}, mecid ${mecid})`);
          }
        }
      }
    } // end for each mechanism

    // 10.7 Verify mechanism count is within bounds
    try {
      const maxMechanismCount = toNum(await api.query.subtensorModule.maxMechanismCount());
      if (mechanismCount > maxMechanismCount) {
        err(`10.7 MechanismCountCurrent[${netuid}]=${mechanismCount} exceeds MaxMechanismCount=${maxMechanismCount}`);
      }
    } catch (e) {
      // MaxMechanismCount might not be queryable
    }
  }

  return overallOk;
}

/**
 * Verify epoch topology constraints:
 * - BlockAtRegistration exists for all UIDs present in Uids(netuid, *)
 * - The following vectors have length == SubnetworkN(netuid):
 *   LastUpdate, ValidatorPermit, Rank, Trust, ValidatorTrust,
 *   Incentive, Dividends, Active, Emission, Consensus, PruningScores
 *
 * Logs every failure with "Constraint error: ..." and returns true iff all pass.
 */
export async function checkEpochTopology(api) {
  const toNum = (x) => (typeof x?.toNumber === "function" ? x.toNumber() : Number(x));
  let ok = true;
  const err = (msg) => { console.log(`Constraint error: ${msg}`); ok = false; };

  // 1) get all active netuids
  let netuids = [];
  try {
    netuids = await subnetsAvailable(api); // number[]
  } catch (e) {
    err(`failed to get subnetsAvailable: ${e?.message ?? e}`);
    return false;
  }
  if (netuids.length === 0) return true;

  for (const netuid of netuids) {
    // Subnetwork size N
    let N = 0;
    try {
      N = toNum(await api.query.subtensorModule.subnetworkN(netuid));
    } catch (e) {
      err(`failed to read SubnetworkN(${netuid}): ${e?.message ?? e}`);
      continue;
    }

    // --- A) BlockAtRegistration must exist for all UIDs in Uids map ---

    // Collect UIDs present in Uids(netuid, *)
    let uidsEntries = [];
    try {
      // Uids is (netuid, hotkey) -> Option<u16>, entries(netuid) gives all present
      uidsEntries = await api.query.subtensorModule.uids.entries(netuid);
    } catch (e) {
      err(`failed to read Uids entries for netuid ${netuid}: ${e?.message ?? e}`);
      uidsEntries = [];
    }
    const uidsPresent = new Set(uidsEntries.map(([_, v]) => {
      const val = v.unwrap ? v.unwrap() : v;
      return toNum(val);
    }));

    // Collect uids that actually have a BlockAtRegistration key
    let barKeys = [];
    try {
      // keys(netuid) returns StorageKey args [netuid, uid]
      barKeys = await api.query.subtensorModule.blockAtRegistration.keys(netuid);
    } catch (e) {
      err(`failed to read BlockAtRegistration keys for netuid ${netuid}: ${e?.message ?? e}`);
      barKeys = [];
    }
    const barUids = new Set(barKeys.map((k) => toNum(k.args[1])));

    // Check coverage
    for (const uid of uidsPresent) {
      if (!barUids.has(uid)) {
        err(`BlockAtRegistration missing for (netuid ${netuid}, uid ${uid})`);
      }
    }

    // --- B) Vector maps must have length exactly N ---

    // helpers to fetch a Vec and compare its .length to N
    const checkLen = async (label, promise) => {
      try {
        const vec = await promise; // polkadot.js Vec<...>
        const len = vec?.length ?? 0;
        if (len !== N) err(`${label}(${netuid}) length ${len} != SubnetworkN ${N}`);
      } catch (e) {
        err(`failed to read ${label}(${netuid}): ${e?.message ?? e}`);
      }
    };

    // Note: LastUpdate & Incentive are keyed by NetUidStorageIndex in your pallet,
    // which polkadot.js typically maps to the same numeric argument usage.
    await checkLen("LastUpdate",       api.query.subtensorModule.lastUpdate(netuid));
    await checkLen("ValidatorPermit",  api.query.subtensorModule.validatorPermit(netuid));
    await checkLen("Rank",             api.query.subtensorModule.rank(netuid));
    await checkLen("Trust",            api.query.subtensorModule.trust(netuid));
    await checkLen("ValidatorTrust",   api.query.subtensorModule.validatorTrust(netuid));
    await checkLen("Incentive",        api.query.subtensorModule.incentive(netuid));
    await checkLen("Dividends",        api.query.subtensorModule.dividends(netuid));
    await checkLen("Active",           api.query.subtensorModule.active(netuid));
    await checkLen("Emission",         api.query.subtensorModule.emission(netuid));
    await checkLen("Consensus",        api.query.subtensorModule.consensus(netuid));
    await checkLen("PruningScores",    api.query.subtensorModule.pruningScores(netuid));
  }

  return ok;
}

import { subnetsAvailable } from './utils.js'

export async function checkKeysUidsConstraints(api) {
  // ---------- helpers ----------
  const toNum = (x) => (typeof x?.toNumber === 'function' ? x.toNumber() : Number(x));
  const toStr = (x) => (x?.toString ? x.toString() : String(x));
  const rangeArray = (n) => Array.from({ length: n }, (_, i) => i);
  const sEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const errPrintSetDiff = (a, b) => {
    if (a.size !== b.size) {
      err(`Size mismatch: ${a.size} != ${b.size}`);
    }
    [...a].every((x) => {
      if (!b.has(x)) {
        err(`${x} appears in one map, but does not appear in another`);
      }
      return b.has(x);
    });
  }

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

  async function countIsNetworkMemberForNetuid(netuid, pageSize = 1000) {
    let startKey;
    let count = 0;
    try {
      for (;;) {
        const page = await api.query.subtensorModule.isNetworkMember.keysPaged({
          args: [], // required by some polkadot.js versions
          pageSize,
          startKey,
        });
        if (page.length === 0) break;
        for (const k of page) {
          const uidArg = toNum(k.args[1]); // (hot, netuid)
          if (uidArg === netuid) count++;
        }
        startKey = page[page.length - 1];
      }
    } catch (e) {
      err(`failed to page IsNetworkMember for netuid ${netuid}: ${e?.message ?? e}`);
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
      const owners = await Promise.all(list.map((h) => api.query.subtensorModule.owner(h)));
      const allSame = owners.every((c) => {
            if (toStr(c) !== cold) {
                err(`8.2 Owner() mismatch in OwnedHotkeys(${cold}); ${toStr(c)} does not map back to ${cold} (netuid ${netuid})`);
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
      errPrintSetDiff(hotsFromKeys, hotsFromUids);
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

//     // 3. No duplicate values in Uids (entries count == N)
//     if (uids.length !== N) {
//       err(`3 Uids has ${uids.length} entries, expected ${N} (duplicates or missing) (netuid ${netuid})`);
//     }

//     // 4. No duplicate values in Keys (no two uids map to same hotkey)
//     if (new Set(keys.map((e) => e.hot)).size !== keys.length) {
//       err(`4 Keys has duplicate hotkeys (size ${new Set(keys.map((e) => e.hot)).size} vs entries ${keys.length}) (netuid ${netuid})`);
//     }

//     // 5. Keys -> Uids exact inverse
//     {
//       const uidsMap = new Map(uids.map((e) => [e.hot, e.uid])); // hot -> uid
//       for (const { uid, hot } of keys) {
//         const u = uidsMap.get(hot);
//         if (u === undefined) {
//           err(`5 Keys(${netuid}, ${uid}) -> ${hot} has no matching Uids(${netuid}, ${hot})`);
//         } else if (u !== uid) {
//           err(`5 Keys(${netuid}, ${uid}) -> ${hot} but Uids(${netuid}, ${hot}) -> ${u} (mismatch)`);
//         }
//       }
//     }

//     // 6. Uids -> Keys exact inverse
//     {
//       const keysMap = new Map(keys.map((e) => [e.uid, e.hot])); // uid -> hot
//       for (const { hot, uid } of uids) {
//         const h = keysMap.get(uid);
//         if (h === undefined) {
//           err(`6 Uids(${netuid}, ${hot}) -> ${uid} has no matching Keys(${netuid}, ${uid})`);
//         } else if (h !== hot) {
//           err(`6 Uids(${netuid}, ${hot}) -> ${uid} but Keys(${netuid}, ${uid}) -> ${h} (mismatch)`);
//         }
//       }
//     }

//     // 8 / 8.1 / 8.2 Owner/OwnedHotkeys linkage for every hot in HKSet
//     for (const hot of HKSet) {
//       const ok = await ownerConsistencyOk(hot, netuid);
//       if (!ok) overallOk = false; // ownerConsistencyOk already logged details
//     }

//     // 9.1 IsNetworkMember == HKSet
//     {
//       // All HKSet members must be true
//       try {
//         const memChecks = await Promise.all(
//           [...HKSet].map((hot) => api.query.subtensorModule.isNetworkMember(hot, netuid))
//         );
//         const allTrue = memChecks.every((v) => v === true || v?.isTrue === true);
//         if (!allTrue) {
//           err(`9.1 Some HKSet hotkeys are not IsNetworkMember(*, ${netuid}) == true`);
//         }
//       } catch (e) {
//         err(`9.1 failed querying IsNetworkMember(*, ${netuid}): ${e?.message ?? e}`);
//       }

//       // No extras (cardinality match)
//       const memberCount = await countIsNetworkMemberForNetuid(netuid);
//       if (memberCount !== HKSet.size) {
//         err(`9.1 IsNetworkMember count(${memberCount}) != HKSet size(${HKSet.size}) (netuid ${netuid})`);
//       }
//     }

//     // 9.2 Axons ⊆ HKSet
//     {
//       const axonHots = await listHotForNetDoubleMap(api.query.subtensorModule.axons, netuid);
//       for (const hot of axonHots) if (!HKSet.has(hot)) err(`9.2 Axons contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
//     }

//     // 9.3 NeuronCertificates ⊆ HKSet
//     {
//       const certHots = await listHotForNetDoubleMap(api.query.subtensorModule.neuronCertificates, netuid);
//       for (const hot of certHots) if (!HKSet.has(hot)) err(`9.3 NeuronCertificates contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
//     }

//     // 9.4 Prometheus ⊆ HKSet
//     {
//       const promHots = await listHotForNetDoubleMap(api.query.subtensorModule.prometheus, netuid);
//       for (const hot of promHots) if (!HKSet.has(hot)) err(`9.4 Prometheus contains hotkey ${hot} not in HKSet (netuid ${netuid})`);
//     }
  }

  return overallOk;
}

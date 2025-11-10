import { ApiPromise, WsProvider } from '@polkadot/api';
import { TransferContract } from './transferContract.js';
import { StakeContract } from './stakeContract.js';
import { UnstakeContract } from './unstakeContract.js';
import { randInt, getStake, getPendingEmissionAt, getPendingServerEmissionAt, getPendingValidatorEmissionAt, getPendingRootAlphaDivsAt } from './utils.js';
import { ContractCallLogger } from './testjournal.js';
import { 
  checkEmission,
  checkEpochTopology,
  checkKeysUidsConstraints,
  checkParentChildRelationship,
  checkStakingConstraints,
  checkWeightsBondsConstraints,
  checkValidatorPermits,
  countChildAndParentKeys,
  countEmptyParentKeys,
  checkLiquidity,
  listEmptyParentKeys,
  checkSimpleLimits
} from './constraints.js';

// const ENDPOINT = 'ws://127.0.0.1:9944';
// const ENDPOINT = 'ws://127.0.0.1:9946';
// const ENDPOINT = 'wss://entrypoint-finney.opentensor.ai';
const ENDPOINT = 'wss://archive.chain.opentensor.ai';

async function chooseContractParameters(contract) {
  const prmCount = contract.parameterCount;
  const parameters = {};
  for (let i = 0; i < prmCount; i++) {
    const prmDesc = await contract.getParameterDesc(i, parameters);
    let value;
    if (prmDesc.selection === "list") {
      const arr = prmDesc.values;
      if (arr.length == 0) return null;
      value = arr[Math.floor(Math.random() * arr.length)];
    } else {
      const { min, max } = prmDesc.values;
      if (min > max) return null;
      value = randInt(min, max);
      value = value.toString();
    }
    parameters[prmDesc.name] = value;
  }
  return parameters;
}

function integrateProbabilities(testProbabilities) {
  let acc = 0;
  for (let i = 0; i < testProbabilities.length; i += 1) {
    acc += testProbabilities[i][0];
    testProbabilities[i][0] = acc;
  }
  return testProbabilities;
}


// server, pending, root: Array<{ netuid: number, valueNumber: number }>
export function checkServerIsHalfPendingPlusRoot(server, pending, root, rel = 1e-9) {
  const toMap = (arr) => new Map((Array.isArray(arr) ? arr : []).map(e => [e.netuid, Number(e.valueNumber ?? 0)]));

  const ms = toMap(server);
  const mp = toMap(pending);
  const mr = toMap(root);

  const netuids = new Set([...ms.keys(), ...mp.keys(), ...mr.keys()]);
  const violations = [];

  for (const n of netuids) {
    const s = ms.get(n) ?? 0;
    const p = mp.get(n) ?? 0;
    const r = mr.get(n) ?? 0;
    const expected = 0.5 * (p + r);

    const diff = Math.abs(s - expected);
    const scale = Math.max(Math.abs(expected), 1);
    const diffPct = (diff / scale) * 100;

    // one-line console output with netuid and diff percentage
    console.log(`netuid=${n} diff_pct=${diffPct.toFixed(6)}%`);

    if (diff / scale > rel) {
      violations.push({ netuid: n, server: s, pending: p, root: r, expected, diff, diffPct });
    }
  }

  return { ok: violations.length === 0, violations };
}

// Inputs are arrays of { netuid: number, valueNumber: number }
// Checks: server[netuid] + validator[netuid] + root[netuid] ≈ pending[netuid]
export function checkServerPlusValidatorPlusRootEqualsPending(
  server,
  validator,
  rootBefore,
  rootAfter,
  pending,
  rel = 1e-9
) {
  const toMap = (arr) =>
    new Map((Array.isArray(arr) ? arr : []).map(e => [e.netuid, Number(e.valueNumber ?? 0)]));

  const mS = toMap(server);
  const mV = toMap(validator);
  const mRB = toMap(rootBefore);
  const mRA = toMap(rootAfter);
  const mP = toMap(pending);

  const netuids = new Set([...mS.keys(), ...mV.keys(), ...mRB.keys(), ...mRA.keys(), ...mP.keys()]);
  const violations = [];

  for (const n of netuids) {
    const s = mS.get(n) ?? 0;
    const v = mV.get(n) ?? 0;
    const rb = mRB.get(n) ?? 0;
    const ra = mRA.get(n) ?? 0;
    const p = mP.get(n) ?? 0;

    const totalBefore = p + rb;
    const totalAfter = s + v;
    const diff = Math.abs(totalBefore - totalAfter);
    const scale = Math.max(Math.abs(totalBefore), 1);
    const ratio = diff / scale;

    if (ratio > rel) {
      violations.push({
        netuid: n,
        server: s,
        validator: v,
        rootBefore: rb,
        rootAfter: ra,
        pending: p,
        totalBefore,
        totalAfter,
        diff,
        diffPct: ratio * 100,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}


async function main() {
  const provider = new WsProvider(ENDPOINT);
  const api = await ApiPromise.create({ provider });
  await api.isReady;
  console.log('Connected to', ENDPOINT);
  const logger = new ContractCallLogger();

  let keysUidsOk = true;
  // keysUidsOk = await checkKeysUidsConstraints(api);
  // console.log(`Keys-Uids constraints OK = ${keysUidsOk}`);
  
  let simpleLimitsOk = true;
  // simpleLimitsOk = await checkSimpleLimits(api);
  // console.log(`Simple limits constraints OK = ${simpleLimitsOk}`);

  let weightsBondsOk = true; 
  // weightsBondsOk = await checkWeightsBondsConstraints(api);
  // console.log(`Weights-Bonds constraints OK = ${weightsBondsOk}`);

  let stakingOk = true;
  // stakingOk = await checkStakingConstraints(api);
  // console.log(`Staking constraints OK = ${stakingOk}`);

  let epochOk = true;
  // epochOk = await checkEpochTopology(api);
  // console.log(`Epoch topology constraints OK = ${epochOk}`);

  let parentChildOk = true;
  // parentChildOk = await checkParentChildRelationship(api);
  // console.log(`Parent-child relationship constraints OK = ${parentChildOk}`);

  let validatorPermitsOk = true;
  // validatorPermitsOk = await checkValidatorPermits(api);
  // console.log(`Validator permit constraints OK = ${validatorPermitsOk}`);

  let liquidityOk = true;
  // liquidityOk = await checkLiquidity(api);
  // console.log(`Liquidity constraints OK = ${liquidityOk}`);

  let emissionOk = true;
  emissionOk = await checkEmission(api);
  console.log(`Emission constraints OK = ${emissionOk}`);

  const constraintsOk = keysUidsOk && simpleLimitsOk && weightsBondsOk && stakingOk && epochOk && parentChildOk && validatorPermitsOk && liquidityOk && emissionOk;
  console.log(`Overall constraints OK = ${constraintsOk}`);

  // let counters = await countChildAndParentKeys(api);
  // console.log(counters);

  // let emptyPk = await countEmptyParentKeys(api);
  // console.log(emptyPk);

  // await listEmptyParentKeys(api);


  // cold, hot
  // const stake = await getStake(api, 18, "5ChuhpMeXgbcwrv8dHzE4t7x1LY15BNqybjPQovi2yrCnghJ", "5G6ULjBQKsedB3LDGjsoYzqXiLeAD6VzBj7RDKhhHtJ4hop9");
  // const stake = await getStake(api, 64, "5FyBy1yBnm1ZLoLGEskzXWLbsCuC9961fkLG1ZTs9DbcnpMB", "5CSa1rZAzh8Nf9nT9wMBghE6DPzTFoEdWZaRXD6mdVBkVJhw");
  // console.log(stake / 1e9);

  // const updateBlock = 6834037;

  // const emission = await getPendingEmissionAt(api, updateBlock);
  // // console.log("", emission);

  // const serverEmission = await getPendingServerEmissionAt(api, updateBlock+1)
  // const validatorEmission = await getPendingValidatorEmissionAt(api, updateBlock+1)
  // // console.log(serverEmission);
  // // console.log(validatorEmission);

  // const rootBefore = await getPendingRootAlphaDivsAt(api, updateBlock)
  // const rootAfter = await getPendingRootAlphaDivsAt(api, updateBlock+1)

  // // const result = checkServerIsHalfPendingPlusRoot(serverEmission, emission, root);
  // // console.log(result);

  // const result = checkServerPlusValidatorPlusRootEqualsPending(serverEmission, validatorEmission, rootBefore, rootAfter, emission, 0.5)
  // console.log(result);

  // while (true) {
  //   try {
  //     // System creates vector-store from the base branch
  //     // System collects the PR diff
  //     // System collects all available tests and their code coverage (top level fn tested)
  //     // LLM decides what tests to prioritize based on the code base, the diff and the test code coverage.
  //     // TODO later

  //     const testProbabilities = integrateProbabilities([
  //       [0.2, TransferContract],
  //       [0.4, StakeContract],
  //       [0.4, UnstakeContract],
  //     ]);

  //     // System chooses one test to run (with probability proposed by the LLM).
  //     const r = Math.random();
  //     const [, cls] = testProbabilities.find(([t]) => r <= t) ?? testProbabilities.at(-1);
  //     const contract = new cls(api);

  //     // Choose contract parameters
  //     const contractPrm = await chooseContractParameters(contract);
  //     console.log(`${cls.name}: ${JSON.stringify(contractPrm)}`);
  //     if (contractPrm === null) continue;

  //     // Execute workflow
  //     const result = await contract.executeFlow({ params: contractPrm });

  //     if (result.ok) {
  //       console.log('✅ Contract executed successfully');
  //       console.log('Action result:', result.actionResult);
  //       await logger.logContractCallOk(contractPrm);
  //     } else {
  //       console.error('❌ Contract failed');
  //       console.error('Stage:', result.stage);
  //       if (result.prompt) console.error('Prompt (debug):\n', result.prompt);
  //       console.error('Error:', result.error);
  //       await logger.logContractCallErr(`Parameters: ${contractPrm}, Error: ${result.error}`);
  //     }

  //   } catch (err) {
  //     console.error('Error:', err);
  //   }
  // };

  await api.disconnect();
}

main().catch(console.error);

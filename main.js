import { ApiPromise, WsProvider } from '@polkadot/api';
import { TransferContract } from './transferContract.js';
import { StakeContract } from './stakeContract.js';
import { UnstakeContract } from './unstakeContract.js';
import { randInt } from './utils.js';
import { ContractCallLogger } from './testjournal.js';
import { 
  checkEpochTopology,
  checkKeysUidsConstraints,
  checkParentChildRelationship,
  checkStakingConstraints,
  checkWeightsBondsConstraints,
  checkValidatorPermits
} from './constraints.js';

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

async function main() {
  const provider = new WsProvider(ENDPOINT);
  const api = await ApiPromise.create({ provider });
  await api.isReady;
  console.log('Connected to', ENDPOINT);
  const logger = new ContractCallLogger();

  let keysUidsOk = true;
  // keysUidsOk = await checkKeysUidsConstraints(api);
  // console.log(`Keys-Uids constraints OK = ${keysUidsOk}`);

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
  validatorPermitsOk = await checkValidatorPermits(api);
  console.log(`Validator permit constraints OK = ${validatorPermitsOk}`);

  const constraintsOk = keysUidsOk && weightsBondsOk && stakingOk && epochOk && parentChildOk && validatorPermitsOk;
  console.log(`Overall constraints OK = ${constraintsOk}`);

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

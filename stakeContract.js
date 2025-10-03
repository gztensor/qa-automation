import { BaseContract, Actor } from './types.js';
import { readFreeBalance, sendTransaction, subnetsAvailable, getAlphaPrice, getValidatorHotkeys } from './utils.js';
import { getActors } from './actorRegistry.js';
import { approxEqualAbs, divAmountByPrice, getStake } from './utils.js'

export class StakeContract extends BaseContract {
  constructor(api) {
    super({
      name: "Stake",
      scope: `add_stake`,
      deps: { api },
      parameterCount: 4,
      getParameterDesc: async(idx, chosenParameters) => {
        if (idx == 0) {
          const actors = getActors([Actor.Coldkey])
          return {
            name: "actor",
            type: "string",
            selection: "list",
            values: actors,
          };
        } else if (idx == 1) {
          // Select the subnet
          const netuids = await subnetsAvailable(api);
          return {
            name: "netuid",
            type: "integer",
            selection: "list",
            values: netuids,
          };
        } else if (idx == 2) {
          // Select the hotkey to stake to
          const netuid = chosenParameters.netuid;
          const valiHotkeys = await getValidatorHotkeys(api, netuid);
          return {
            name: "hotkey",
            type: "string",
            selection: "list",
            values: valiHotkeys,
          };
        } else if (idx == 3) {
          const senderBalance = await readFreeBalance(api, chosenParameters.actor.address);
          return {
            name: "amount",
            type: "integer",
            selection: "range",
            values: {
              min: 1,
              max: senderBalance
            },
          }
        }
      },

      /* ---------------------------- PRECONDITION ---------------------------- */
      precondition: async ({ params }) => {
        const api = this.deps.api;
        const senderBalance = await readFreeBalance(api, params.actor.address);
        const senderStake = await getStake(api, params.netuid, params.actor.address, params.hotkey);
        const alphaPrice = await getAlphaPrice(api, params.netuid);
        return {
          senderBalanceBefore: senderBalance.toString(),
          senderStakeBefore: senderStake.toString(),
          alphaPrice,
        };
      },

      /* -------------------------------- ACTION ----------------------------- */
      action: async ({ params }) => {
        const api = this.deps.api;
        const amountStr = String(params.amount);
        let amount = BigInt(amountStr);

        // Real chain call:
        const stake = api.tx.subtensorModule.addStake(params.hotkey, params.netuid, params.amount);
        await sendTransaction(api, stake, params.actor);

        return {
          amount: amount.toString(),
        };
      },

      /* --------------------------- POSTCONDITION --------------------------- */
      postcondition: async ({ params, pre, actionResult }) => {
        const api = this.deps.api;
        const { amount } = actionResult;

        const senderBalanceBefore = BigInt(pre.senderBalanceBefore);
        const amt = BigInt(amount);

        // Read AFTER balances
        const senderBalanceAfter = await readFreeBalance(api, params.actor.address);
        const senderBalanceDelta = senderBalanceBefore - senderBalanceAfter; // should be >= amt (fees make it larger)
        const balanceOk = senderBalanceDelta >= amt; // allow for fees
        
        // Read AFTER stake
        const senderStakeAfter = await getStake(api, params.netuid, params.actor.address, params.hotkey);
        // const expectedStakeDelta = divAmountByPrice(BigInt(params.amount), pre.alphaPrice);
        const stakeDelta = senderStakeAfter - BigInt(pre.senderStakeBefore);

        return balanceOk && 
          // approxEqualAbs(expectedStakeDelta, stakeDelta, expectedStakeDelta / 2n) &&
          ((stakeDelta > 0n) || (amt == 0n));
      },
    });
  }
}

import { BaseContract, Actor } from './types.js';
import { readFreeBalance, sendTransaction, subnetsAvailable, getAlphaPrice, getValidatorHotkeys } from './utils.js';
import { getActorByAddressAndType, getRegistry } from './actorRegistry.js';
import { approxEqualAbs, mulAmountByPrice, getHotkeysStakedByColdkey, getRegistryColdkeysWithAlpha, getStake } from './utils.js'

export class UnstakeContract extends BaseContract {
  constructor(api) {
    super({
      name: "Unstake",
      scope: `remove_stake`,
      deps: { api },
      parameterCount: 4,
      getParameterDesc: async(idx, chosenParameters) => {
        if (idx == 0) {
          // Select the subnet
          const netuids = await subnetsAvailable(api);
          return {
            name: "netuid",
            type: "integer",
            selection: "list",
            values: netuids,
          };
        } else if (idx == 1) {
          // Select the actor
          const registry = getRegistry();
          const coldkeys = await getRegistryColdkeysWithAlpha(api, registry, chosenParameters.netuid);
          const coldkeyActors = coldkeys
            .map(addr => getActorByAddressAndType(addr, Actor.Coldkey))
            .filter(Boolean);
          return {
            name: "actor",
            type: "string",
            selection: "list",
            values: coldkeyActors,
          };
        } else if (idx == 2) {
          // Select the hotkey to unstake from
          const hotkeys = await getHotkeysStakedByColdkey(api, chosenParameters.actor.address, chosenParameters.netuid);
          return {
            name: "hotkey",
            type: "string",
            selection: "list",
            values: hotkeys,
          };
        } else if (idx == 3) {
          const senderStake = await getStake(api, chosenParameters.netuid, chosenParameters.actor.address, chosenParameters.hotkey);
          return {
            name: "amount",
            type: "integer",
            selection: "range",
            values: {
              min: 1,
              max: senderStake
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
        const unstake = api.tx.subtensorModule.removeStake(params.hotkey, params.netuid, params.amount);
        await sendTransaction(api, unstake, params.actor);

        return {
          amount: amount.toString(),
        };
      },

      /* --------------------------- POSTCONDITION --------------------------- */
      postcondition: async ({ params, pre, actionResult }) => {
        const api = this.deps.api;

        const senderBalanceBefore = BigInt(pre.senderBalanceBefore);

        // Read AFTER balances
        const expectedSenderBalanceDelta = mulAmountByPrice(BigInt(params.amount), pre.alphaPrice);
        const senderBalanceAfter = await readFreeBalance(api, params.actor.address);
        const senderBalanceDelta = senderBalanceAfter - senderBalanceBefore; // should be >= amt (fees make it larger)
        
        // Read AFTER stake
        const senderStakeAfter = await getStake(api, params.netuid, params.actor.address, params.hotkey);
        const stakeDelta = BigInt(pre.senderStakeBefore) - senderStakeAfter;

        return (BigInt(params.amount) == stakeDelta) && 
          approxEqualAbs(expectedSenderBalanceDelta, senderBalanceDelta, expectedSenderBalanceDelta / 2n);
      },
    });
  }
}

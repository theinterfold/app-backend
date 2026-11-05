import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper, { E3Stage } from '@helpers/crisp'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import { IPluginInterfaceType } from '@types'

const llo = logger.logMeta.bind(null, { service: 'service:indexer:CrispRoundSweep' })

/**
 * Settles the CRISP proposals whose round outcome the Interfold events did not deliver.
 *
 * Interfold emits `E3Failed` only when someone calls `markE3Failed`, so a round nobody reports stays pending forever.
 * And a coordinator crawl that runs ahead of a plugin's own crawl meets the round events before the proposal exists,
 * so it skips them. Each run asks the coordinator about the round of every unsettled proposal (not executed, tally
 * not published, no failure reason): a complete round gets its tally, a failed one the reason the coordinator stored,
 * and one that missed a deadline the reason `checkFailureCondition` reports. A read that fails is logged and skipped,
 * the proposal is asked again on the next run.
 */
export const CrispRoundSweep = {
  start: async (): Promise<void> => {
    const proposals = await Models.Proposal.find({
      e3Id: { $exists: true },
      'executed.status': { $ne: true },
      isTallyPublished: { $ne: true },
      failureReason: { $exists: false },
    })
    if (proposals.length === 0) return

    const plugins = await Models.Plugin.find({
      interfaceType: IPluginInterfaceType.crisp,
      interfoldAddress: { $exists: true },
      address: { $in: [...new Set(proposals.map(proposal => proposal.pluginAddress))] },
    })
    const pluginOf = new Map<string, Plugin>(plugins.map(plugin => [`${plugin.network}-${plugin.address}`, plugin]))

    for (const proposal of proposals) {
      const { _id, network, pluginAddress, proposalIndex } = proposal
      const plugin = pluginOf.get(`${network}-${pluginAddress}`)
      if (!plugin) continue
      const interfold = plugin.interfoldAddress!
      const e3Id = proposal.e3Id!

      try {
        const stage = await CrispHelper.getE3Stage(interfold, e3Id, network)
        if (stage === E3Stage.Complete) {
          await CrispInterfoldHandler.syncTally(proposal, plugin)
          continue
        }

        let reason: number | undefined
        if (stage === E3Stage.Failed) {
          reason = await CrispHelper.getFailureReason(interfold, e3Id, network)
        } else {
          const condition = await CrispHelper.checkFailureCondition(interfold, e3Id, network)
          if (condition.canFail) reason = condition.reason
        }
        if (reason === undefined) continue

        // not over a reason an `E3Failed` event stored meanwhile
        await Models.Proposal.updateOne({ _id, failureReason: { $exists: false } }, { $set: { failureReason: reason } })
        logger.verbose('CrispRoundSweep: round marked failed', llo({ network, pluginAddress, proposalIndex, reason }))
      } catch (error) {
        logger.error('CrispRoundSweep: cannot check the round', llo({ network, pluginAddress, proposalIndex, error }))
      }
    }
  },
}

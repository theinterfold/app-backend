import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper, { E3Stage } from '@helpers/crisp'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import { IPluginInterfaceType } from '@types'

const llo = logger.logMeta.bind(null, { service: 'service:indexer:CrispRoundSweep' })

// A failed read is logged and retried on the next run
const backfillRounds = async (addresses: string[], pluginOf: Map<string, Plugin>): Promise<void> => {
  const proposals = await Models.Proposal.find({ pluginAddress: { $in: addresses }, e3Id: { $exists: false } })

  for (const proposal of proposals) {
    const { network, pluginAddress, proposalIndex } = proposal
    const plugin = pluginOf.get(`${network}-${pluginAddress}`)
    if (!plugin) continue

    try {
      await CrispInterfoldHandler.backfillProposal(proposal, plugin)
    } catch (error) {
      logger.error('CrispRoundSweep: cannot read the round', llo({ network, pluginAddress, proposalIndex, error }))
    }
  }
}

/**
 * Settles the CRISP proposals whose round data or outcome the indexer events did not deliver.
 *
 * A proposal stored without its round (the read at creation failed) is first given it, which is the only way it gets
 * one: the Interfold events and this sweep both look a round up by `e3Id`. A plugin whose coordinator is not stored is
 * asked for it again, as its rounds cannot be checked without it.
 *
 * Interfold emits `E3Failed` only when someone calls `markE3Failed`, so a round nobody reports stays pending forever.
 * And a coordinator crawl that runs ahead of a plugin's own crawl meets the round events before the proposal exists,
 * so it skips them. Each run asks the coordinator about the round of every unsettled proposal (tally not published, no
 * failure reason; an executed proposal whose final tally read failed is one of them): a complete round gets its tally,
 * a failed one the reason the coordinator stored, and one that missed a deadline the reason `checkFailureCondition`
 * reports. A round still running records its stage and the deadline it fails on in that stage, so a stalled committee
 * or computation shows until when it may run. A read that fails is logged and skipped, the proposal is asked again on
 * the next run.
 */
export const CrispRoundSweep = {
  start: async (): Promise<void> => {
    const plugins: Plugin[] = await Models.Plugin.find({ interfaceType: IPluginInterfaceType.crisp })
    if (plugins.length === 0) return

    // a plugin whose coordinator could not be read yet is asked again, its rounds cannot be checked without it
    for (const plugin of plugins) {
      try {
        await CrispInterfoldHandler.ensureInterfold(plugin)
      } catch (error) {
        logger.error(
          'CrispRoundSweep: cannot read the Interfold of the plugin',
          llo({ network: plugin.network, pluginAddress: plugin.address, error }),
        )
      }
    }

    // by plugin address, which the proposal indexes lead with; the plugin of a proposal is told by network and
    // address, as the same address can be a plugin on two networks
    const addresses = [...new Set(plugins.map(plugin => plugin.address))]
    const pluginOf = new Map<string, Plugin>(plugins.map(plugin => [`${plugin.network}-${plugin.address}`, plugin]))

    await backfillRounds(addresses, pluginOf)

    const proposals = await Models.Proposal.find({
      pluginAddress: { $in: addresses },
      e3Id: { $exists: true },
      isTallyPublished: { $ne: true },
      failureReason: { $exists: false },
    })

    for (const proposal of proposals) {
      const { _id, network, pluginAddress, proposalIndex } = proposal
      const plugin = pluginOf.get(`${network}-${pluginAddress}`)
      if (!plugin?.interfoldAddress) continue
      const interfold = plugin.interfoldAddress
      const e3Id = proposal.e3Id!

      try {
        const stage = await CrispHelper.getE3Stage(interfold, e3Id, network)
        if (stage === E3Stage.Complete) {
          await CrispInterfoldHandler.syncTally(proposal, plugin)
          continue
        }

        // A stage's deadline is set when the round enters it, so it is read once per stage
        if (stage !== E3Stage.Failed && stage !== proposal.e3Stage) {
          const deadline = await CrispHelper.getStageDeadline(interfold, e3Id, stage, network)
          await Models.Proposal.updateOne(
            { _id },
            deadline === undefined
              ? { $set: { e3Stage: stage }, $unset: { e3StageDeadline: 1 } }
              : { $set: { e3Stage: stage, e3StageDeadline: deadline } },
          )
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

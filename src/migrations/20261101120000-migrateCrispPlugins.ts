import { Models } from '@dbModels'
import { PluginSettingHandler } from '@handlers/pluginSettingHandler'
import ConfigIndexerHelper from '@helpers/configIndexer'
import PluginDetector from '@helpers/pluginDetector'
import { PluginSlug } from '@helpers/pluginSlug'
import RabbitMQHelper from '@helpers/rabbitMQ'
import Web3Helper from '@helpers/web3'
import logger from '@logger'
import type Plugin from '@models/schema/plugin'
import { ProxyToken } from '@modules/proxyToken'
import {
  EnumQueueName,
  type ILogInfo,
  type IMigration,
  IPluginInterfaceType,
  IPluginStatus,
  ISettingStatus,
} from '@types'

const MIGRATION = '20261101120000-migrateCrispPlugins'
const llo = logger.logMeta.bind(null, { service: `Migration: ${MIGRATION}` })

/**
 * CrispVoting also exposes `getVotingToken()` and `totalVotingPower(uint256)`, so before the
 * detector probed `CRISP_FUNCTIONS` first every installed CRISP plugin was stored as token voting.
 * Those plugins were crawled under token voting: no settings (the event signature differs), no
 * support flag, and a proposal list whose tally the token-voting metrics job overwrote with zeros.
 *
 * Selection is by bytecode, not by address: a stored `tokenVoting` plugin is a misdetected CRISP
 * plugin exactly when today's detector classifies it as `crisp`.
 */
export const findMisdetectedCrispPlugins = async (): Promise<Plugin[]> => {
  const candidates: Plugin[] = await Models.Plugin.find({
    interfaceType: IPluginInterfaceType.tokenVoting,
    status: { $in: [IPluginStatus.installed, IPluginStatus.preInstall] },
  })

  const misdetected: Plugin[] = []
  for (const plugin of candidates) {
    const detected = await PluginDetector.detectPluginType(plugin.address, plugin.network)
    if (detected.type === IPluginInterfaceType.crisp) misdetected.push(plugin)
  }

  return misdetected
}

export const migrateCrispPlugin = async (plugin: Plugin): Promise<void> => {
  const { address, network } = plugin
  const info = {
    address,
    network,
    blockNumber: plugin.blockNumber,
    transactionHash: plugin.transactionHash,
  } as ILogInfo

  // Everything that can fail runs before the type is flipped: once flipped, the plugin is no
  // longer selected, so a failure after that point could never be retried by re-running.
  const onChain = await Web3Helper.getCrispSettings(address, network)
  if (!onChain) throw new Error(`Cannot read CRISP settings of ${address} on ${network}`)

  const tokenAddress = plugin.tokenAddress || (await Web3Helper.getVotingToken(address, network))

  // Settings stored under the old type, if any, have the token-voting shape. Replace them with
  // the contract's current values; the crawl below replays any later VotingSettingsUpdated on top.
  await Models.Setting.deleteMany({ pluginAddress: address, network })
  await Models.Setting.create({
    blockNumber: plugin.blockNumber,
    blockTimestamp: plugin.blockTimestamp,
    transactionHash: plugin.transactionHash,
    status: ISettingStatus.active,
    daoAddress: plugin.daoAddress,
    pluginAddress: address,
    pluginSubdomain: plugin.subdomain,
    tokenAddress,
    network,
    minParticipation: onChain.minParticipation,
    supportThreshold: onChain.supportThreshold,
    minDuration: onChain.minDuration,
    minProposerVotingPower: onChain.minProposerVotingPower.toString(),
    minVoterVotingPower: onChain.minVoterVotingPower.toString(),
    committeeSize: onChain.committeeSize,
    paramSet: onChain.paramSet,
  })

  if (tokenAddress) {
    const token = await ProxyToken.saveAndGetToken(tokenAddress, network)
    if (!token) throw new Error(`Cannot resolve voting token ${tokenAddress} of ${address} on ${network}`)
    if (token.isGovernance) await PluginSettingHandler.isSupported(plugin, info)
  }

  // Proposals indexed under token voting carry zeroed metrics, and re-crawling skips documents
  // that already exist, so drop them and let the crisp crawl rebuild them from the events.
  await Models.Proposal.deleteMany({ pluginAddress: address, network })
  await Models.Vote.deleteMany({ pluginAddress: address, network })
  await Models.PluginMetrics.deleteMany({ pluginAddress: address, network })

  await Models.ConfigIndexer.deleteMany({
    network,
    service: {
      $in: [
        ConfigIndexerHelper.builders.plugin(IPluginInterfaceType.tokenVoting, network, address),
        ConfigIndexerHelper.builders.plugin(IPluginInterfaceType.crisp, network, address),
      ],
    },
  })

  await Models.Plugin.updateOne(
    { id: plugin.id },
    { interfaceType: IPluginInterfaceType.crisp, isObjection: false, ...(tokenAddress && { tokenAddress }) },
  )
  const updated: Plugin = await Models.Plugin.findOne({ id: plugin.id })

  // The slug defaults to the interface type (a processKey from the plugin metadata wins).
  await PluginSlug.updateSlug(updated, updated.processKey)

  if (plugin.status === IPluginStatus.installed) {
    await RabbitMQHelper.sendMessage(EnumQueueName.plugins, {
      id: address,
      params: { address, network },
    })
  }
}

export const migrateCrispPluginsMigration: IMigration = {
  start: async () => {
    logger.info('Starting migration', llo({ migration: MIGRATION }))

    try {
      const plugins = await findMisdetectedCrispPlugins()
      logger.info('Misdetected crisp plugins', llo({ migration: MIGRATION, count: plugins.length }))

      for (const plugin of plugins) {
        await migrateCrispPlugin(plugin)
        logger.verbose(
          'Migrated crisp plugin',
          llo({ migration: MIGRATION, pluginAddress: plugin.address, network: plugin.network }),
        )
      }

      logger.info('Migration completed successfully', llo({ migration: MIGRATION, migrated: plugins.length }))
    } catch (error) {
      logger.error('Migration failed', llo({ migration: MIGRATION, error }))
      throw error
    }
  },

  stop: async () => {
    // Usually empty for migrations
  },
}

export default migrateCrispPluginsMigration

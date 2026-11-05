import config from '@config'
import { Models } from '@dbModels'
import RabbitMQHelper from '@helpers/rabbitMQ'
import logger from '@logger'
import { LogGauge } from '@plugins/logGauge'
import { LogPolicy } from '@plugins/logPolicy'
import { CrispRoundSweep } from '@services/aragon-plugins/crispRoundSweep'
import { LogAdmin } from '@services/aragon-plugins/logAdmin'
import { LogCapitalDistributor } from '@services/aragon-plugins/logCapitalDistributor'
import { LogCrossChain } from '@services/aragon-plugins/logCrossChain'
import { LogDao } from '@services/aragon-plugins/logDao'
import { LogDelegateChanged } from '@services/aragon-plugins/logDelegateChanged'
import { LogInterfold } from '@services/aragon-plugins/logInterfold'
import { LogMultiSig } from '@services/aragon-plugins/logMultisig'
import { LogSelectorPermission } from '@services/aragon-plugins/logSelectorPermission'
import { LogSpp } from '@services/aragon-plugins/logSPP'
import { LogTokenVoting } from '@services/aragon-plugins/logTokenVoting'
import { TaskSchedulerState } from '@state/taskSchedulerState'
import {
  EnumConnection,
  EnumQueueName,
  EnumServiceName,
  IPluginInterfaceType,
  IPluginStatus,
  type IQueueDao,
  type IQueueLogInterfold,
  type IQueuePlugin,
  type IQueueSyncDelegateChanged,
  type IService,
  ITokenType,
} from '@types'

const llo = logger.logMeta.bind(null, { service: 'service:PluginSyncService' })

// The scheduler only runs a task on a tick that lands after nextStartAt. A tick equal to the interval arrives a few
// milliseconds early and gets skipped, which doubles the effective period, so the tick has to be much shorter.
const TASK_CHECK_INTERVAL_MS = 5 * 1000

const AragonPluginsService: IService & { pluginQueue: (params: IQueuePlugin) => Promise<void> } = {
  name: EnumServiceName.ARAGON_PLUGINS,
  NEED_CONNECTIONS: [EnumConnection.MONGODB, EnumConnection.BLOCKCHAIN, EnumConnection.RABBITMQ],
  options: { mongoSync: config.MONGO_DB.SYNC_MODELS },

  async start() {
    await RabbitMQHelper.process(EnumQueueName.logDao, async job => {
      const { address, network } = job.params as IQueueDao
      const dao = await Models.Dao.findByAddress(address, network)
      if (!dao) return
      await LogDao.start(dao)
    })

    await RabbitMQHelper.process(EnumQueueName.logSelectorPermission, async job => {
      const { address, network, conditionAddress, daoAddress } = job.params as IQueuePlugin
      const plugin = await Models.Plugin.findOne({
        address,
        network,
        conditionAddress,
        status: IPluginStatus.installed,
        ...(daoAddress ? { daoAddress } : {}),
      })
      if (!plugin) {
        logger.error('PluginSyncService: plugin not found', llo({ address, network }))
        return
      }
      await LogSelectorPermission.start(plugin)
    })

    await RabbitMQHelper.process(EnumQueueName.plugins, async job => {
      await AragonPluginsService.pluginQueue(job.params as IQueuePlugin)
    })

    await RabbitMQHelper.process(EnumQueueName.requeue, async job => {
      await AragonPluginsService.pluginQueue(job.params as IQueuePlugin)
    })

    await RabbitMQHelper.process(EnumQueueName.syncDelegateChanged, async job => {
      const { pluginAddress, network } = job.params as IQueueSyncDelegateChanged
      const plugin = await Models.Plugin.findByAddress(pluginAddress, network)
      if (!plugin) {
        logger.error('syncDelegateChanged: plugin not found', llo({ pluginAddress, network }))
        return
      }
      await LogDelegateChanged.start(plugin)
    })

    await RabbitMQHelper.process(EnumQueueName.logInterfold, async job => {
      await LogInterfold.start((job.params as IQueueLogInterfold).network)
    })

    await TaskSchedulerState.getInstance().startTask('crispRoundSweep', {
      fn: () => [[{ crispRoundSweep: CrispRoundSweep }]],
      interval: config.SERVICES.ARAGON_PLUGINS.CRISP_ROUND_SWEEP_INTERVAL,
      checkInterval: TASK_CHECK_INTERVAL_MS,
      runNow: false,
      stopOnError: false,
      onError: (error: any) => {
        logger.error('PluginSyncService crispRoundSweep task error', llo({ error }))
      },
    })

    logger.info('PluginSyncService service started', llo({}))
  },

  async stop() {
    TaskSchedulerState.getInstance().stopTask('crispRoundSweep')
    logger.info('PluginSyncService service stopped', llo({}))
  },

  pluginQueue: async (params: IQueuePlugin) => {
    const { address, network, isHistorical } = params
    const plugin = await Models.Plugin.findByAddress(address, network)

    if (!plugin?.interfaceType) {
      logger.error('PluginSyncService: plugin not found', llo({ address, network }))
      return
    }

    switch (plugin.interfaceType) {
      case IPluginInterfaceType.admin: {
        await LogAdmin.start(plugin)
        break
      }
      case IPluginInterfaceType.multisig: {
        await LogMultiSig.start(plugin)
        break
      }
      case IPluginInterfaceType.crisp:
      case IPluginInterfaceType.tokenVoting: {
        const token = await Models.Token.findOne({
          address: plugin.tokenAddress,
          network: plugin.network,
        })

        if (
          (token?.type === ITokenType.ERC20 ||
            token?.type === ITokenType.ERC721 ||
            token?.type === ITokenType.escrowAdapter ||
            token?.type === ITokenType.bondedVotes) &&
          token?.isGovernance &&
          token?.hasDelegate
        ) {
          logger.info(
            'Sync tokenVoting plugin',
            llo({ plugin: plugin.address, token: token.address, tokenTye: token.type }),
          )

          await LogTokenVoting.start(plugin, token, isHistorical)
        } else {
          logger.warn('Sync plugin token not supported', llo({ plugin: plugin?.address, token: token?.address }))
        }

        if (plugin.interfaceType === IPluginInterfaceType.crisp) await LogInterfold.queue(plugin)
        break
      }
      case IPluginInterfaceType.spp: {
        await LogSpp.start(plugin)
        break
      }
      case IPluginInterfaceType.gauge: {
        const token = await Models.Token.findOne({
          address: plugin.tokenAddress,
          network: plugin.network,
        })

        await Promise.all([
          LogGauge.start(plugin, isHistorical),
          LogTokenVoting.runEscrowCrawler(plugin, token, isHistorical),
        ])

        break
      }
      case IPluginInterfaceType.capitalDistributor: {
        logger.info('Sync plugin: Capital Distributor', llo({ plugin: plugin.address }))
        await LogCapitalDistributor.start(plugin)
        break
      }
      case IPluginInterfaceType.claimer:
      case IPluginInterfaceType.router: {
        logger.info(`Sync plugin: ${plugin.interfaceType}`, llo({ network: plugin.network, plugin: plugin.address }))
        await LogPolicy.start(plugin.address, plugin.network)
        break
      }
      case IPluginInterfaceType.crossChainController: {
        logger.info('Sync plugin: CrossChainController', llo({ network: plugin.network, plugin: plugin.address }))
        await LogCrossChain.start(plugin)
        break
      }
      default: {
        break
      }
    }
  },
}

export default AragonPluginsService

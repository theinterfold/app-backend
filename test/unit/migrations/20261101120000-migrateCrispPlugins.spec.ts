import { Models } from '@dbModels'
import { PluginSettingHandler } from '@handlers/pluginSettingHandler'
import ConfigIndexerHelper from '@helpers/configIndexer'
import PluginDetector from '@helpers/pluginDetector'
import { PluginSlug } from '@helpers/pluginSlug'
import RabbitMQHelper from '@helpers/rabbitMQ'
import Web3Helper from '@helpers/web3'
import logger from '@logger'
import { ProxyToken } from '@modules/proxyToken'
import migrateCrispPluginsMigration, {
  findMisdetectedCrispPlugins,
  migrateCrispPlugin,
} from '@src/migrations/20261101120000-migrateCrispPlugins'
import { EnumQueueName, IPluginInfo, IPluginInterfaceType, IPluginStatus, ISettingStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('migration: migrateCrispPlugins', () => {
  let sandbox: SinonSandbox
  let detectStub: SinonStub
  let sendMessageStub: SinonStub

  const crispAddress = '0x1111111111111111111111111111111111111111'
  const tokenVotingAddress = '0x2222222222222222222222222222222222222222'
  const multisigAddress = '0x3333333333333333333333333333333333333333'
  const daoAddress = '0xabCDef1234567890abCdEF1234567890ABcDeF12'
  const tokenAddress = '0xTokenAddress123'
  const network = NetworksEnum.ethereumSepolia

  const createPlugin = (address: string, interfaceType: IPluginInterfaceType, status = IPluginStatus.installed) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType,
      status,
      tokenAddress,
      blockNumber: 1000,
      transactionHash: `0xinstall-${address}`,
    })

  const onChainSettings = {
    minProposerVotingPower: 10n,
    minVoterVotingPower: 5n,
    minParticipation: 15,
    supportThreshold: 50,
    minDuration: 86_400,
    committeeSize: 1,
    paramSet: 2,
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sendMessageStub = sandbox.stub(RabbitMQHelper, 'sendMessage').resolves()
    detectStub = sandbox.stub(PluginDetector, 'detectPluginType').callsFake(async (address: string) => {
      const type = address === crispAddress ? IPluginInterfaceType.crisp : IPluginInterfaceType.tokenVoting
      return { type } as IPluginInfo
    })
    sandbox.stub(logger, 'info')
    sandbox.stub(logger, 'verbose')
  })

  afterEach(() => {
    sandbox?.restore()
  })

  describe('findMisdetectedCrispPlugins', () => {
    it('should select only stored tokenVoting plugins whose bytecode is CRISP', async () => {
      await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      await createPlugin(tokenVotingAddress, IPluginInterfaceType.tokenVoting)
      await createPlugin(multisigAddress, IPluginInterfaceType.multisig)

      const result = await findMisdetectedCrispPlugins()

      expect(result.map(plugin => plugin.address)).to.deep.equal([crispAddress])
      // The multisig is never probed: only stored tokenVoting plugins are candidates.
      expect(detectStub.callCount).to.equal(2)
    })

    it('should skip a plugin that cannot be probed and keep looking at the others', async () => {
      const unprobeable = '0x4444444444444444444444444444444444444444'
      await createPlugin(unprobeable, IPluginInterfaceType.tokenVoting)
      await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      sandbox.stub(logger, 'error')
      detectStub.callsFake(async (address: string) => {
        if (address === unprobeable) throw new Error('rpc down')
        return { type: IPluginInterfaceType.crisp } as IPluginInfo
      })

      const result = await findMisdetectedCrispPlugins()

      expect(result.map(plugin => plugin.address)).to.deep.equal([crispAddress])
    })

    it('should skip uninstalled plugins and plugins already stored as crisp', async () => {
      await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting, IPluginStatus.abandoned)
      await createPlugin(tokenVotingAddress, IPluginInterfaceType.crisp)

      expect(await findMisdetectedCrispPlugins()).to.have.lengthOf(0)
    })
  })

  describe('migrateCrispPlugin', () => {
    let isSupportedStub: SinonStub
    let updateSlugStub: SinonStub

    beforeEach(() => {
      sandbox.stub(Web3Helper, 'getCrispSettings').resolves(onChainSettings)
      sandbox.stub(ProxyToken, 'saveAndGetToken').resolves({ isGovernance: true } as any)
      isSupportedStub = sandbox.stub(PluginSettingHandler, 'isSupported').resolves()
      updateSlugStub = sandbox.stub(PluginSlug, 'updateSlug').resolves('crisp')
    })

    it('should re-type the plugin, backfill its settings, reset the crawl and requeue it', async () => {
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      await Models.Proposal.create({
        transactionHash: '0xproposal',
        pluginAddress: crispAddress,
        proposalIndex: '0',
        network,
        blockNumber: 1001,
        daoAddress,
        creatorAddress: '0xcreator',
        startDate: 1,
        endDate: 2,
        title: 'zeroed under tokenVoting',
      })
      await Models.ConfigIndexer.create({
        network,
        service: ConfigIndexerHelper.builders.plugin(IPluginInterfaceType.tokenVoting, network, crispAddress),
        lastSync: 5000,
      })

      await migrateCrispPlugin(plugin)

      const migrated = await Models.Plugin.findOne({ address: crispAddress, network })
      expect(migrated.interfaceType).to.equal(IPluginInterfaceType.crisp)
      expect(migrated.isObjection).to.equal(false)

      const setting = await Models.Setting.findActive({ pluginAddress: crispAddress, network })
      expect(setting.status).to.equal(ISettingStatus.active)
      expect(setting.minProposerVotingPower).to.equal('10')
      expect(setting.minVoterVotingPower).to.equal('5')
      expect(setting.minParticipation).to.equal(15)
      expect(setting.supportThreshold).to.equal(50)
      expect(setting.minDuration).to.equal(86_400)
      expect(setting.committeeSize).to.equal(1)
      expect(setting.paramSet).to.equal(2)

      expect(isSupportedStub.calledOnce).to.be.true
      expect(updateSlugStub.calledOnce).to.be.true
      expect(updateSlugStub.firstCall.args[0].interfaceType).to.equal(IPluginInterfaceType.crisp)

      expect(await Models.Proposal.find({ pluginAddress: crispAddress })).to.have.lengthOf(0)
      expect(
        await Models.ConfigIndexer.find({
          service: ConfigIndexerHelper.builders.plugin(IPluginInterfaceType.tokenVoting, network, crispAddress),
        }),
      ).to.have.lengthOf(0)

      expect(sendMessageStub.calledOnceWith(EnumQueueName.plugins)).to.be.true
      expect(sendMessageStub.firstCall.args[1]).to.deep.equal({
        id: `${network}-${crispAddress}`,
        params: { address: crispAddress, network },
      })
    })

    it('should replace a stale token-voting-shaped setting', async () => {
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      await Models.Setting.create({
        blockNumber: 1000,
        transactionHash: plugin.transactionHash,
        status: ISettingStatus.active,
        daoAddress,
        pluginAddress: crispAddress,
        network,
        votingMode: 0,
        supportThreshold: 500_000,
      })

      await migrateCrispPlugin(plugin)

      const settings = await Models.Setting.find({ pluginAddress: crispAddress, network })
      expect(settings).to.have.lengthOf(1)
      expect(settings[0].supportThreshold).to.equal(50)
      expect(settings[0].votingMode).to.be.undefined
    })

    it('should not flag support when the token is not a governance token', async () => {
      ;(ProxyToken.saveAndGetToken as SinonStub).resolves({ isGovernance: false })
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)

      await migrateCrispPlugin(plugin)

      expect(isSupportedStub.called).to.be.false
    })

    it('should not requeue a plugin that is not installed', async () => {
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting, IPluginStatus.preInstall)

      await migrateCrispPlugin(plugin)

      expect(sendMessageStub.called).to.be.false
    })

    it('should leave the plugin untouched when its voting token cannot be resolved', async () => {
      ;(ProxyToken.saveAndGetToken as SinonStub).resolves(null)
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      await Models.Setting.create({
        blockNumber: 1000,
        transactionHash: plugin.transactionHash,
        status: ISettingStatus.active,
        daoAddress,
        pluginAddress: crispAddress,
        network,
        supportThreshold: 500_000,
      })

      let error: Error | undefined
      try {
        await migrateCrispPlugin(plugin)
      } catch (e) {
        error = e as Error
      }

      expect(error?.message).to.contain('Cannot resolve voting token')
      const settings = await Models.Setting.find({ pluginAddress: crispAddress, network })
      expect(settings.map(setting => setting.supportThreshold)).to.deep.equal([500_000])
    })

    it('should leave the plugin selectable when the contract cannot be read', async () => {
      ;(Web3Helper.getCrispSettings as SinonStub).resolves(null)
      const plugin = await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)

      let error: Error | undefined
      try {
        await migrateCrispPlugin(plugin)
      } catch (e) {
        error = e as Error
      }

      expect(error?.message).to.contain('Cannot read CRISP settings')
      expect(await findMisdetectedCrispPlugins()).to.have.lengthOf(1)
      expect(sendMessageStub.called).to.be.false
    })
  })

  describe('start', () => {
    it('should migrate every misdetected plugin', async () => {
      await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      await createPlugin(tokenVotingAddress, IPluginInterfaceType.tokenVoting)
      sandbox.stub(Web3Helper, 'getCrispSettings').resolves(onChainSettings)
      sandbox.stub(ProxyToken, 'saveAndGetToken').resolves({ isGovernance: true } as any)
      sandbox.stub(PluginSettingHandler, 'isSupported').resolves()
      sandbox.stub(PluginSlug, 'updateSlug').resolves('crisp')

      await migrateCrispPluginsMigration.start()

      expect((await Models.Plugin.findOne({ address: crispAddress })).interfaceType).to.equal(
        IPluginInterfaceType.crisp,
      )
      expect((await Models.Plugin.findOne({ address: tokenVotingAddress })).interfaceType).to.equal(
        IPluginInterfaceType.tokenVoting,
      )
    })

    it('should skip a plugin that cannot be migrated and still migrate the others', async () => {
      const planted = '0x4444444444444444444444444444444444444444'
      await createPlugin(planted, IPluginInterfaceType.tokenVoting)
      await createPlugin(crispAddress, IPluginInterfaceType.tokenVoting)
      detectStub.resolves({ type: IPluginInterfaceType.crisp } as IPluginInfo)
      const errorStub = sandbox.stub(logger, 'error')
      sandbox.stub(Web3Helper, 'getCrispSettings').callsFake(async (address: string) => {
        if (address === planted) throw new Error('execution reverted')
        return onChainSettings
      })
      sandbox.stub(ProxyToken, 'saveAndGetToken').resolves({ isGovernance: true } as any)
      sandbox.stub(PluginSettingHandler, 'isSupported').resolves()
      sandbox.stub(PluginSlug, 'updateSlug').resolves('crisp')

      await migrateCrispPluginsMigration.start()

      expect((await Models.Plugin.findOne({ address: crispAddress })).interfaceType).to.equal(
        IPluginInterfaceType.crisp,
      )
      expect((await Models.Plugin.findOne({ address: planted })).interfaceType).to.equal(
        IPluginInterfaceType.tokenVoting,
      )
      expect(errorStub.calledWith('Migration failed' as any)).to.be.false
    })

    it('should log and rethrow when it fails', async () => {
      const errorStub = sandbox.stub(logger, 'error')
      sandbox.stub(Models.Plugin, 'find').rejects(new Error('Database error'))

      let error: Error | undefined
      try {
        await migrateCrispPluginsMigration.start()
      } catch (e) {
        error = e as Error
      }

      expect(error?.message).to.equal('Database error')
      expect(errorStub.calledWith('Migration failed' as any)).to.be.true
    })
  })
})

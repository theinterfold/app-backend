import '@test/environment'
import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper, { E3Stage } from '@helpers/crisp'
import logger from '@logger'
import { CrispRoundSweep } from '@services/aragon-plugins/crispRoundSweep'
import { IPluginInterfaceType, IPluginStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('AragonPlugins: CrispRoundSweep', () => {
  let sandbox: SinonSandbox
  let stageStub: SinonStub
  let checkStub: SinonStub
  let failureReasonStub: SinonStub
  let syncTallyStub: SinonStub

  const network = NetworksEnum.ethereumSepolia
  const pluginAddress = '0x1111111111111111111111111111111111111111'
  const coordinator = '0x3333333333333333333333333333333333333333'
  const daoAddress = '0x6666666666666666666666666666666666666666'

  const createPlugin = (address: string, interfoldAddress?: string) =>
    Models.Plugin.create({
      address,
      daoAddress,
      network,
      interfaceType: IPluginInterfaceType.crisp,
      status: IPluginStatus.installed,
      blockNumber: 1000,
      transactionHash: `0xinstall${address}`,
      interfoldAddress,
    })

  const createProposal = (proposalIndex: string, extra: Record<string, unknown> = {}, plugin = pluginAddress) =>
    Models.Proposal.create({
      transactionHash: `0xcreate${plugin}${proposalIndex}`,
      blockNumber: 1100,
      network,
      pluginAddress: plugin,
      daoAddress,
      proposalIndex,
      creatorAddress: '0x7777777777777777777777777777777777777777',
      startDate: 1,
      endDate: 2,
      incrementalId: Number(proposalIndex),
      proposalId: `0x0${proposalIndex}`,
      e3Id: `10${proposalIndex}`,
      ...extra,
    } as any)

  const reasonOf = async (proposalIndex: string) =>
    (await Models.Proposal.findOne({ pluginAddress, proposalIndex })).failureReason

  beforeEach(async () => {
    sandbox = sinon.createSandbox()
    sandbox.stub(logger, 'verbose')
    sandbox.stub(logger, 'error')
    stageStub = sandbox.stub(CrispHelper, 'getE3Stage').resolves(E3Stage.KeyPublished)
    checkStub = sandbox.stub(CrispHelper, 'checkFailureCondition').resolves({ canFail: false, reason: 0 })
    failureReasonStub = sandbox.stub(CrispHelper, 'getFailureReason').resolves(6)
    syncTallyStub = sandbox.stub(CrispInterfoldHandler, 'syncTally').resolves()
    await createPlugin(pluginAddress, coordinator)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should store the reason of a round that can be marked failed', async () => {
    await createProposal('1')
    checkStub.resolves({ canFail: true, reason: 3 })

    await CrispRoundSweep.start()

    expect(stageStub.calledOnceWith(coordinator, '101', network)).to.be.true
    expect(checkStub.calledOnceWith(coordinator, '101', network)).to.be.true
    expect(await reasonOf('1')).to.equal(3)
  })

  it('should leave a round that cannot be marked failed alone', async () => {
    await createProposal('1')

    await CrispRoundSweep.start()

    expect(checkStub.calledOnce).to.be.true
    expect(await reasonOf('1')).to.equal(undefined)
  })

  it('should store the reason the coordinator recorded for a failed round', async () => {
    await createProposal('1')
    stageStub.resolves(E3Stage.Failed)

    await CrispRoundSweep.start()

    expect(failureReasonStub.calledOnceWith(coordinator, '101', network)).to.be.true
    expect(checkStub.called).to.be.false
    expect(await reasonOf('1')).to.equal(6)
  })

  it('should sync the tally of a complete round instead of marking it failed', async () => {
    const proposal = await createProposal('1')
    stageStub.resolves(E3Stage.Complete)
    checkStub.resolves({ canFail: true, reason: 3 })

    await CrispRoundSweep.start()

    expect(syncTallyStub.calledOnce).to.be.true
    const [syncedProposal, syncedPlugin] = syncTallyStub.firstCall.args
    expect(syncedProposal._id.toString()).to.equal(proposal._id.toString())
    expect(syncedPlugin.address).to.equal(pluginAddress)
    expect(checkStub.called).to.be.false
    expect(await reasonOf('1')).to.equal(undefined)
  })

  it('should not overwrite a reason an E3Failed event stored while the round was read', async () => {
    await createProposal('1')
    checkStub.callsFake(async () => {
      await Models.Proposal.updateOne({ pluginAddress, proposalIndex: '1' }, { $set: { failureReason: 2 } })
      return { canFail: true, reason: 3 }
    })

    await CrispRoundSweep.start()

    expect(await reasonOf('1')).to.equal(2)
  })

  it('should not read the proposals that are settled or not rounds', async () => {
    await createProposal('1', { executed: { status: true, blockNumber: 1200 } })
    await createProposal('2', { isTallyPublished: true })
    await createProposal('3', { failureReason: 6 })
    await createProposal('4', { e3Id: undefined })
    const noCoordinator = '0x2222222222222222222222222222222222222222'
    await createPlugin(noCoordinator)
    await createProposal('5', {}, noCoordinator)

    await CrispRoundSweep.start()

    expect(stageStub.called).to.be.false
    expect(syncTallyStub.called).to.be.false
  })

  it('should keep checking the other proposals when one read fails', async () => {
    await createProposal('1')
    await createProposal('2')
    await createProposal('3')
    stageStub.callsFake(async (_interfold: string, e3Id: string) => {
      if (e3Id === '101') throw new Error('rpc')
      return E3Stage.KeyPublished
    })
    checkStub.callsFake(async (_interfold: string, e3Id: string) => ({ canFail: e3Id === '103', reason: 5 }))

    await CrispRoundSweep.start()

    expect(stageStub.callCount).to.equal(3)
    expect(await reasonOf('1')).to.equal(undefined)
    expect(await reasonOf('2')).to.equal(undefined)
    expect(await reasonOf('3')).to.equal(5)
  })
})

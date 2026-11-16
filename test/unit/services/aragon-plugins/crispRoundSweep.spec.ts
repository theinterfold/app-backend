import '@test/environment'
import { Models } from '@dbModels'
import { CrispInterfoldHandler } from '@handlers/crispInterfoldHandler'
import CrispHelper, { E3Stage } from '@helpers/crisp'
import ProposalHelper from '@helpers/proposal'
import logger from '@logger'
import { CrispRoundSweep } from '@services/aragon-plugins/crispRoundSweep'
import { IPluginInterfaceType, IPluginStatus, NetworksEnum } from '@types'
import { expect } from 'chai'
import * as sinon from 'sinon'
import { SinonSandbox, SinonStub } from 'sinon'

describe('AragonPlugins: CrispRoundSweep', () => {
  let sandbox: SinonSandbox
  let stageStub: SinonStub
  let deadlineStub: SinonStub
  let checkStub: SinonStub
  let failureReasonStub: SinonStub
  let syncTallyStub: SinonStub
  let getProposalStub: SinonStub
  let getInterfoldStub: SinonStub

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
    deadlineStub = sandbox.stub(CrispHelper, 'getStageDeadline').resolves(undefined)
    checkStub = sandbox.stub(CrispHelper, 'checkFailureCondition').resolves({ canFail: false, reason: 0 })
    failureReasonStub = sandbox.stub(CrispHelper, 'getFailureReason').resolves(6)
    syncTallyStub = sandbox.stub(CrispInterfoldHandler, 'syncTally').resolves()
    getProposalStub = sandbox.stub(ProposalHelper, 'getProposalCrisp').resolves(null)
    getInterfoldStub = sandbox.stub(CrispHelper, 'getInterfold').rejects(new Error('rpc'))
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

  it('should record the stage of a running round and the deadline it fails on', async () => {
    await createProposal('1', { e3Stage: E3Stage.KeyPublished, e3StageDeadline: 500 })
    stageStub.resolves(E3Stage.CiphertextReady)
    deadlineStub.resolves(900)

    await CrispRoundSweep.start()

    expect(deadlineStub.calledOnceWith(coordinator, '101', E3Stage.CiphertextReady, network)).to.be.true
    const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
    expect(proposal.e3Stage).to.equal(E3Stage.CiphertextReady)
    expect(proposal.e3StageDeadline).to.equal(900)
  })

  it('should drop the deadline of the previous stage when the new one has none', async () => {
    await createProposal('1', { e3Stage: E3Stage.None, e3StageDeadline: 500 })
    stageStub.resolves(E3Stage.Requested)

    await CrispRoundSweep.start()

    const proposal = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
    expect(proposal.e3Stage).to.equal(E3Stage.Requested)
    expect(proposal.e3StageDeadline).to.equal(undefined)
  })

  it('should not read the deadline again while the round stays in its stage', async () => {
    await createProposal('1', { e3Stage: E3Stage.KeyPublished, e3StageDeadline: 500 })

    await CrispRoundSweep.start()

    expect(deadlineStub.called).to.be.false
    expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3StageDeadline).to.equal(500)
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
    await createProposal('1', { executed: { status: true, blockNumber: 1200 }, isTallyPublished: true })
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

  it('should sync the tally of an executed proposal whose final tally was not stored', async () => {
    await createProposal('1', { executed: { status: true, blockNumber: 1200 }, isTallyPublished: false })
    stageStub.resolves(E3Stage.Complete)

    await CrispRoundSweep.start()

    expect(syncTallyStub.calledOnce).to.be.true
    expect(syncTallyStub.firstCall.args[0].proposalIndex).to.equal('1')
  })

  it('should ask the coordinator of a plugin that has none stored, then check its rounds', async () => {
    const noCoordinator = '0x2222222222222222222222222222222222222222'
    await createPlugin(noCoordinator)
    await createProposal('1', {}, noCoordinator)
    getInterfoldStub.resolves(coordinator as any)

    await CrispRoundSweep.start()

    expect(getInterfoldStub.calledOnceWith(noCoordinator, network)).to.be.true
    expect((await Models.Plugin.findOne({ address: noCoordinator })).interfoldAddress).to.equal(coordinator)
    expect(stageStub.calledOnceWith(coordinator, '101', network)).to.be.true
  })

  it('should keep going when the coordinator of one plugin cannot be read', async () => {
    const noCoordinator = '0x2222222222222222222222222222222222222222'
    await createPlugin(noCoordinator)
    await createProposal('1', {}, noCoordinator)
    await createProposal('2')

    await CrispRoundSweep.start()

    expect(getInterfoldStub.calledOnce).to.be.true
    expect(stageStub.calledOnceWith(coordinator, '102', network)).to.be.true
  })

  it('should not check a proposal against the plugin of the same address on another network', async () => {
    await createProposal('1', { network: NetworksEnum.arbitrumMainnet })

    await CrispRoundSweep.start()

    expect(stageStub.called).to.be.false
  })

  describe('proposals stored without their round', () => {
    const onChain = {
      e3Id: 7n,
      parameters: { snapshotBlock: 900n, minVotingPower: 50n, minParticipation: 20n, supportThreshold: 60n },
    }

    beforeEach(() => {
      sandbox.stub(CrispHelper, 'getTotalVotingPower').resolves('5000')
      sandbox.stub(CrispHelper, 'getVotingPowerDivisor').resolves('1000')
    })

    it('should give the round to a proposal whose read at creation failed, and settle it in the same run', async () => {
      await createProposal('1', { e3Id: undefined })
      // the read at creation failed: no round data, which leaves a null read behind
      getProposalStub.resolves(null)
      await CrispRoundSweep.start()
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal(undefined)
      expect(stageStub.called).to.be.false

      getProposalStub.resolves(onChain as any)
      checkStub.resolves({ canFail: true, reason: 3 })
      await CrispRoundSweep.start()

      const stored = await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })
      expect(getProposalStub.calledWith({ proposalIndex: '1', pluginAddress, network, blockNumber: undefined })).to.be
        .true
      expect(stored.e3Id).to.equal('7')
      expect(stored.isTallyPublished).to.be.false
      expect(stored.votingPowerDivisor).to.equal('1000')
      expect(stored.snapshot.totalSupply).to.equal('5000')
      expect(stored.settings.minParticipation).to.equal(20)
      expect(stored.settings.supportThreshold).to.equal(60)
      expect(stored.settings.minVoterVotingPower).to.equal('50')
      expect(stageStub.calledOnceWith(coordinator, '7', network)).to.be.true
      expect(stored.failureReason).to.equal(3)
    })

    it('should keep going when the read of one proposal throws', async () => {
      await createProposal('1', { e3Id: undefined })
      await createProposal('2', { e3Id: undefined })
      getProposalStub.callsFake(async ({ proposalIndex }) => {
        if (proposalIndex === '1') throw new Error('rpc')
        return onChain as any
      })

      await CrispRoundSweep.start()

      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '1' })).e3Id).to.equal(undefined)
      expect((await Models.Proposal.findOne({ pluginAddress, proposalIndex: '2' })).e3Id).to.equal('7')
    })

    it('should not read the proposals of other plugins', async () => {
      const otherPlugin = '0x2222222222222222222222222222222222222222'
      await Models.Plugin.create({
        address: otherPlugin,
        daoAddress,
        network,
        interfaceType: IPluginInterfaceType.tokenVoting,
        status: IPluginStatus.installed,
        blockNumber: 1000,
        transactionHash: `0xinstall${otherPlugin}`,
      } as any)
      await createProposal('1', { e3Id: undefined }, otherPlugin)

      await CrispRoundSweep.start()

      expect(getProposalStub.called).to.be.false
    })
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

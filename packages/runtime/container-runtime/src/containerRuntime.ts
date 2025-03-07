/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */
import { EventEmitter } from "events";
import { ITelemetryBaseLogger, ITelemetryGenericEvent, ITelemetryLogger } from "@fluidframework/common-definitions";
import {
    FluidObject,
    IFluidHandle,
    IFluidHandleContext,
    IFluidRouter,
    IRequest,
    IResponse,
} from "@fluidframework/core-interfaces";
import {
    IAudience,
    IFluidTokenProvider,
    IContainerContext,
    IDeltaManager,
    IDeltaSender,
    IRuntime,
    ICriticalContainerError,
    AttachState,
    ILoaderOptions,
    LoaderHeader,
    ISnapshotTreeWithBlobContents,
} from "@fluidframework/container-definitions";
import {
    IContainerRuntime,
    IContainerRuntimeEvents,
} from "@fluidframework/container-runtime-definitions";
import {
    assert,
    Trace,
    TypedEventEmitter,
    unreachableCase,
    performance,
} from "@fluidframework/common-utils";
import {
    ChildLogger,
    raiseConnectedEvent,
    PerformanceEvent,
    TaggedLoggerAdapter,
    MonitoringContext,
    loggerToMonitoringContext,
    TelemetryDataTag,
} from "@fluidframework/telemetry-utils";
import { DriverHeader, IDocumentStorageService, ISummaryContext } from "@fluidframework/driver-definitions";
import { readAndParse } from "@fluidframework/driver-utils";
import {
    DataCorruptionError,
    DataProcessingError,
    GenericError,
    UsageError,
    extractSafePropertiesFromMessage,
} from "@fluidframework/container-utils";
import {
    IClientDetails,
    IDocumentMessage,
    IQuorumClients,
    ISequencedDocumentMessage,
    ISignalMessage,
    ISnapshotTree,
    ISummaryContent,
    ISummaryTree,
    MessageType,
    SummaryType,
} from "@fluidframework/protocol-definitions";
import {
    FlushMode,
    InboundAttachMessage,
    IFluidDataStoreContextDetached,
    IFluidDataStoreRegistry,
    IFluidDataStoreChannel,
    IGarbageCollectionData,
    IGarbageCollectionDetailsBase,
    IEnvelope,
    IInboundSignalMessage,
    ISignalEnvelope,
    NamedFluidDataStoreRegistryEntries,
    ISummaryTreeWithStats,
    ISummarizeInternalResult,
    CreateChildSummarizerNodeParam,
    SummarizeInternalFn,
    channelsTreeName,
    IAttachMessage,
    IDataStore,
    ITelemetryContext,
} from "@fluidframework/runtime-definitions";
import {
    addBlobToSummary,
    addSummarizeResultToSummary,
    addTreeToSummary,
    createRootSummarizerNodeWithGC,
    IRootSummarizerNodeWithGC,
    RequestParser,
    create404Response,
    exceptionToResponse,
    requestFluidObject,
    responseToException,
    seqFromTree,
    calculateStats,
    TelemetryContext,
} from "@fluidframework/runtime-utils";
import { GCDataBuilder, trimLeadingAndTrailingSlashes } from "@fluidframework/garbage-collector";
import { v4 as uuid } from "uuid";
import { ContainerFluidHandleContext } from "./containerHandleContext";
import { FluidDataStoreRegistry } from "./dataStoreRegistry";
import { Summarizer } from "./summarizer";
import { SummaryManager } from "./summaryManager";
import { DeltaScheduler } from "./deltaScheduler";
import {
    ReportOpPerfTelemetry,
    latencyThreshold,
    IPerfSignalReport,
} from "./connectionTelemetry";
import { IPendingLocalState, PendingStateManager } from "./pendingStateManager";
import { pkgVersion } from "./packageVersion";
import { BlobManager, IBlobManagerLoadInfo } from "./blobManager";
import { DataStores, getSummaryForDatastores } from "./dataStores";
import {
    aliasBlobName,
    blobsTreeName,
    chunksBlobName,
    electedSummarizerBlobName,
    extractSummaryMetadataMessage,
    IContainerRuntimeMetadata,
    ICreateContainerMetadata,
    ISummaryMetadataMessage,
    metadataBlobName,
    wrapSummaryInChannelsTree,
} from "./summaryFormat";
import { SummaryCollection } from "./summaryCollection";
import { ISerializedElection, OrderedClientCollection, OrderedClientElection } from "./orderedClientElection";
import { SummarizerClientElection, summarizerClientType } from "./summarizerClientElection";
import {
    SubmitSummaryResult,
    IConnectableRuntime,
    IGeneratedSummaryStats,
    ISubmitSummaryOptions,
    ISummarizer,
    ISummarizerInternalsProvider,
    ISummarizerOptions,
    ISummarizerRuntime,
} from "./summarizerTypes";
import { formExponentialFn, Throttler } from "./throttler";
import { RunWhileConnectedCoordinator } from "./runWhileConnectedCoordinator";
import {
    GarbageCollector,
    GCNodeType,
    gcTreeKey,
    IGarbageCollectionRuntime,
    IGarbageCollector,
    IGCStats,
} from "./garbageCollection";
import {
    channelToDataStore,
    IDataStoreAliasMessage,
    isDataStoreAliasMessage,
} from "./dataStore";
import { BindBatchTracker } from "./batchTracker";
import { ISerializedBaseSnapshotBlobs, SerializedSnapshotStorage } from "./serializedSnapshotStorage";
import { OpTracker } from "./opTelemetry";

export enum ContainerMessageType {
    // An op to be delivered to store
    FluidDataStoreOp = "component",

    // Creates a new store
    Attach = "attach",

    // Chunked operation.
    ChunkedOp = "chunkedOp",

    // Signifies that a blob has been attached and should not be garbage collected by storage
    BlobAttach = "blobAttach",

    // Ties our new clientId to our old one on reconnect
    Rejoin = "rejoin",

    // Sets the alias of a root data store
    Alias = "alias",
}

export interface IChunkedOp {
    chunkId: number;

    totalChunks: number;

    contents: string;

    originalType: MessageType | ContainerMessageType;
}

export interface ContainerRuntimeMessage {
    contents: any;
    type: ContainerMessageType;
}
export interface ISummaryBaseConfiguration {
    /**
     *  Delay before first attempt to spawn summarizing container.
     */
    initialSummarizerDelayMs: number;

    /**
     * Flag that will enable changing elected summarizer client after maxOpsSinceLastSummary.
     * This defaults to false (disabled) and must be explicitly set to true to enable.
     */
    summarizerClientElection: boolean;

    /**
     * Defines the maximum allowed time to wait for a pending summary ack.
     * The maximum amount of time client will wait for a summarize is the minimum of
     * maxSummarizeAckWaitTime (currently 10 * 60 * 1000) and maxAckWaitTime.
     */
    maxAckWaitTime: number;
    /**
     * Defines the maximum number of Ops in between Summaries that can be
     * allowed before forcibly electing a new summarizer client.
     */
    maxOpsSinceLastSummary: number;
}

export interface ISummaryConfigurationHeuristics extends ISummaryBaseConfiguration {
    state: "enabled";
    /**
     * Defines the maximum allowed time in between summarizations.
     */
    idleTime: number;
    /**
     * Defines the maximum allowed time, since the last received Ack,  before running the summary
     * with reason maxTime.
     */
    maxTime: number;
    /**
     * Defines the maximum number of Ops, since the last received Ack, that can be allowed
     * before running the summary with reason maxOps.
     */
    maxOps: number;
    /**
     * Defines the minimum number of Ops, since the last received Ack, that can be allowed
     * before running the last summary.
     */
    minOpsForLastSummaryAttempt: number;
}

export interface ISummaryConfigurationDisableSummarizer {
    state: "disabled";
}

export interface ISummaryConfigurationDisableHeuristics extends ISummaryBaseConfiguration {
    state: "disableHeuristics";
}

export type ISummaryConfiguration =
| ISummaryConfigurationDisableSummarizer
| ISummaryConfigurationDisableHeuristics
| ISummaryConfigurationHeuristics;

export const DefaultSummaryConfiguration: ISummaryConfiguration = {
    state: "enabled",

    idleTime: 5000 * 3,

    maxTime: 5000 * 12,

    maxOps: 100, // Summarize if 100 ops received since last snapshot.

    minOpsForLastSummaryAttempt: 10,

    maxAckWaitTime: 6 * 10 * 1000, // 6 min.

    maxOpsSinceLastSummary: 7000,

    initialSummarizerDelayMs: 5000, // 5 secs.

    summarizerClientElection: false,
};

export interface IGCRuntimeOptions {
    /**
     * Flag that if true, will enable running garbage collection (GC) in a container. GC has mark phase and sweep phase.
     * In mark phase, unreferenced objects are identified and marked as such in the summary. This option enables the
     * mark phase.
     * In sweep phase, unreferenced objects are eventually deleted from the container if they meet certain conditions.
     * Sweep phase can be enabled via the "sweepAllowed" option.
     * Note: This setting becomes part of the container's summary and cannot be changed.
     */
    gcAllowed?: boolean;

    /**
     * Flag that if true, enables GC's sweep phase which will eventually delete unreferenced objects from the container.
     * This flag should only be set to true if "gcAllowed" is true.
     * Note: This setting becomes part of the container's summary and cannot be changed.
     */
    sweepAllowed?: boolean;

    /**
     * Flag that will disable garbage collection if set to true. Can be used to disable running GC on container where
     * is allowed via the gcAllowed option.
     */
    disableGC?: boolean;

    /**
     * Flag that will bypass optimizations and generate GC data for all nodes irrespective of whether a node
     * changed or not.
     */
    runFullGC?: boolean;

    /**
     * Allows additional GC options to be passed.
     */
    [key: string]: any;
}

export interface ISummaryRuntimeOptions {

    /** Override summary configurations set by the server. */
    summaryConfigOverrides?: ISummaryConfiguration;

    // Flag that disables putting channels in isolated subtrees for each data store
    // and the root node when generating a summary if set to true.
    // Defaults to FALSE (enabled) for now.
    disableIsolatedChannels?: boolean;

    /**
     *  @deprecated - use `summaryConfigOverrides.initialSummarizerDelayMs` instead.
     *  Delay before first attempt to spawn summarizing container.
    */
    initialSummarizerDelayMs?: number;

    /**
     * @deprecated - use `summaryConfigOverrides.disableSummaries` instead.
     * Flag that disables summaries if it is set to true.
     */
    disableSummaries?: boolean;

    /**
     * @deprecated - use `summaryConfigOverrides.maxOpsSinceLastSummary` instead.
     * Defaults to 7000 ops
     */
    maxOpsSinceLastSummary?: number;

     /**
     * @deprecated - use `summaryConfigOverrides.summarizerClientElection` instead.
     * Flag that will enable changing elected summarizer client after maxOpsSinceLastSummary.
     * This defaults to false (disabled) and must be explicitly set to true to enable.
     */
    summarizerClientElection?: boolean;

    /**
     * @deprecated - use `summaryConfigOverrides.state = "DisableHeuristics"` instead.
     *  Options that control the running summarizer behavior. */
    summarizerOptions?: Readonly<Partial<ISummarizerOptions>>;
}

/**
 * Options for container runtime.
 */
export interface IContainerRuntimeOptions {
    readonly summaryOptions?: ISummaryRuntimeOptions;
    readonly gcOptions?: IGCRuntimeOptions;
    /**
     * Affects the behavior while loading the runtime when the data verification check which
     * compares the DeltaManager sequence number (obtained from protocol in summary) to the
     * runtime sequence number (obtained from runtime metadata in summary) finds a mismatch.
     * 1. "close" (default) will close the container with an assertion.
     * 2. "log" will log an error event to telemetry, but still continue to load.
     * 3. "bypass" will skip the check entirely. This is not recommended.
     */
    readonly loadSequenceNumberVerification?: "close" | "log" | "bypass";
    /**
     * Should the runtime use data store aliasing for creating root datastores.
     * In case of aliasing conflicts, the runtime will raise an exception which does
     * not effect the status of the container.
     */
    readonly useDataStoreAliasing?: boolean;
    /**
     * Sets the flush mode for the runtime. In Immediate flush mode the runtime will immediately
     * send all operations to the driver layer, while in TurnBased the operations will be buffered
     * and then sent them as a single batch at the end of the turn.
     * By default, flush mode is TurnBased.
     */
    readonly flushMode?: FlushMode;
    /**
     * Save enough runtime state to be able to serialize upon request and load to the same state in a new container.
     */
    readonly enableOfflineLoad?: boolean;
}

type IRuntimeMessageMetadata = undefined | {
    batch?: boolean;
};

/**
 * The summary tree returned by the root node. It adds state relevant to the root of the tree.
 */
export interface IRootSummaryTreeWithStats extends ISummaryTreeWithStats {
    /** The garbage collection stats if GC ran, undefined otherwise. */
    gcStats?: IGCStats;
}

/**
 * Accepted header keys for requests coming to the runtime.
 */
export enum RuntimeHeaders {
    /** True to wait for a data store to be created and loaded before returning it. */
    wait = "wait",
    /**
     * True if the request is from an external app. Used for GC to handle scenarios where a data store
     * is deleted and requested via an external app.
     */
    externalRequest = "externalRequest",
    /** True if the request is coming from an IFluidHandle. */
    viaHandle = "viaHandle",
}

/**
 * @deprecated
 * Untagged logger is unsupported going forward. There are old loaders with old ContainerContexts that only
 * have the untagged logger, so to accommodate that scenario the below interface is used. It can be removed once
 * its usage is removed from TaggedLoggerAdapter fallback.
 */
interface OldContainerContextWithLogger extends Omit<IContainerContext, "taggedLogger"> {
    logger: ITelemetryBaseLogger;
    taggedLogger: undefined;
}

/**
 * State saved when the container closes, to be given back to a newly
 * instantiated runtime in a new instance of the container, so it can load to the
 * same state
 */
export interface IPendingRuntimeState {
    /**
     * Pending ops from PendingStateManager
     */
    pending?: IPendingLocalState;
    /**
     * A base snapshot at a sequence number prior to the first pending op
     */
    baseSnapshot: ISnapshotTree;
    /**
     * Serialized blobs from the base snapshot. Used to load offline since
     * storage is not available.
     */
    snapshotBlobs: ISerializedBaseSnapshotBlobs;
    /**
     * All runtime ops since base snapshot sequence number up to the latest op
     * seen when the container was closed. Used to apply stashed (saved pending)
     * ops at the same sequence number at which they were made.
     */
    savedOps: ISequencedDocumentMessage[];
}

const useDataStoreAliasingKey = "Fluid.ContainerRuntime.UseDataStoreAliasing";
const maxConsecutiveReconnectsKey = "Fluid.ContainerRuntime.MaxConsecutiveReconnects";

// Feature gate for the max op size. If the value is negative, chunking is enabled
// and all ops over 16k would be chunked. If the value is positive, all ops with
// a size strictly larger will be rejected and the container closed with an error.
const maxOpSizeInBytesKey = "Fluid.ContainerRuntime.MaxOpSizeInBytes";

// By default, we should reject any op larger than 768KB,
// in order to account for some extra overhead from serialization
// to not reach the 1MB limits in socket.io and Kafka.
const defaultMaxOpSizeInBytes = 768000;

// By default, the size of the contents for the incoming ops is tracked.
// However, in certain situations, this may incur a performance hit.
// The feature-gate below can be used to disable this feature.
const disableOpTrackingKey = "Fluid.ContainerRuntime.DisableOpTracking";

const defaultFlushMode = FlushMode.TurnBased;

export enum RuntimeMessage {
    FluidDataStoreOp = "component",
    Attach = "attach",
    ChunkedOp = "chunkedOp",
    BlobAttach = "blobAttach",
    Rejoin = "rejoin",
    Alias = "alias",
    Operation = "op",
}

export function isRuntimeMessage(message: ISequencedDocumentMessage): boolean {
    if ((Object.values(RuntimeMessage) as string[]).includes(message.type)) {
        return true;
    }
    return false;
}

export function unpackRuntimeMessage(message: ISequencedDocumentMessage) {
    if (message.type === MessageType.Operation) {
        // legacy op format?
        if (message.contents.address !== undefined && message.contents.type === undefined) {
            message.type = ContainerMessageType.FluidDataStoreOp;
        } else {
            // new format
            const innerContents = message.contents as ContainerRuntimeMessage;
            assert(innerContents.type !== undefined, 0x121 /* "Undefined inner contents type!" */);
            message.type = innerContents.type;
            message.contents = innerContents.contents;
        }
        assert(isRuntimeMessage(message), 0x122 /* "Message to unpack is not proper runtime message" */);
    } else {
        // Legacy format, but it's already "unpacked",
        // i.e. message.type is actually ContainerMessageType.
        // Nothing to do in such case.
    }
    return message;
}

/**
 * This class controls pausing and resuming of inbound queue to ensure that we never
 * start processing ops in a batch IF we do not have all ops in the batch.
 */
class ScheduleManagerCore {
    private pauseSequenceNumber: number | undefined;
    private currentBatchClientId: string | undefined;
    private localPaused = false;
    private timePaused = 0;
    private batchCount = 0;

    constructor(
        private readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        private readonly logger: ITelemetryLogger,
    ) {
        // Listen for delta manager sends and add batch metadata to messages
        this.deltaManager.on("prepareSend", (messages: IDocumentMessage[]) => {
            if (messages.length === 0) {
                return;
            }

            // First message will have the batch flag set to true if doing a batched send
            const firstMessageMetadata = messages[0].metadata as IRuntimeMessageMetadata;
            if (!firstMessageMetadata?.batch) {
                return;
            }

            // If the batch contains only a single op, clear the batch flag.
            if (messages.length === 1) {
                delete firstMessageMetadata.batch;
                return;
            }

            // Set the batch flag to false on the last message to indicate the end of the send batch
            const lastMessage = messages[messages.length - 1];
            lastMessage.metadata = { ...lastMessage.metadata, batch: false };
        });

        // Listen for updates and peek at the inbound
        this.deltaManager.inbound.on(
            "push",
            (message: ISequencedDocumentMessage) => {
                this.trackPending(message);
            });

        // Start with baseline - empty inbound queue.
        assert(!this.localPaused, 0x293 /* "initial state" */);

        const allPending = this.deltaManager.inbound.toArray();
        for (const pending of allPending) {
            this.trackPending(pending);
        }

        // We are intentionally directly listening to the "op" to inspect system ops as well.
        // If we do not observe system ops, we are likely to hit 0x296 assert when system ops
        // precedes start of incomplete batch.
        this.deltaManager.on("op", (message) => this.afterOpProcessing(message.sequenceNumber));
    }

    /**
     * The only public function in this class - called when we processed an op,
     * to make decision if op processing should be paused or not afer that.
     */
     public afterOpProcessing(sequenceNumber: number) {
        assert(!this.localPaused, 0x294 /* "can't have op processing paused if we are processing an op" */);

        // If the inbound queue is ever empty, nothing to do!
        if (this.deltaManager.inbound.length === 0) {
            assert(this.pauseSequenceNumber === undefined,
                0x295 /* "there should be no pending batch if we have no ops" */);
            return;
        }

        // The queue is
        // 1. paused only when the next message to be processed is the beginning of a batch. Done in two places:
        //    - here (processing ops until reaching start of incomplete batch)
        //    - in trackPending(), when queue was empty and start of batch showed up.
        // 2. resumed when batch end comes in (in trackPending())

        // do we have incomplete batch to worry about?
        if (this.pauseSequenceNumber !== undefined) {
            assert(sequenceNumber < this.pauseSequenceNumber,
                0x296 /* "we should never start processing incomplete batch!" */);
            // If the next op is the start of incomplete batch, then we can't process it until it's fully in - pause!
            if (sequenceNumber + 1 === this.pauseSequenceNumber) {
                this.pauseQueue();
            }
        }
    }

    private pauseQueue() {
        assert(!this.localPaused, 0x297 /* "always called from resumed state" */);
        this.localPaused = true;
        this.timePaused = performance.now();
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        this.deltaManager.inbound.pause();
    }

    private resumeQueue(startBatch: number, messageEndBatch: ISequencedDocumentMessage) {
        const endBatch = messageEndBatch.sequenceNumber;
        const duration = this.localPaused ? (performance.now() - this.timePaused) : undefined;

        this.batchCount++;
        if (this.batchCount % 1000 === 1) {
            this.logger.sendTelemetryEvent({
                eventName: "BatchStats",
                sequenceNumber: endBatch,
                length: endBatch - startBatch + 1,
                msnDistance: endBatch - messageEndBatch.minimumSequenceNumber,
                duration,
                batchCount: this.batchCount,
                interrupted: this.localPaused,
            });
        }

        // Return early if no change in value
        if (!this.localPaused) {
            return;
        }

        this.localPaused = false;

        // Random round number - we want to know when batch waiting paused op processing.
        if (duration !== undefined && duration > latencyThreshold) {
            this.logger.sendErrorEvent({
                eventName: "MaxBatchWaitTimeExceeded",
                duration,
                sequenceNumber: endBatch,
                length: endBatch - startBatch,
            });
        }
        this.deltaManager.inbound.resume();
    }

    /**
     * Called for each incoming op (i.e. inbound "push" notification)
     */
    private trackPending(message: ISequencedDocumentMessage) {
        assert(this.deltaManager.inbound.length !== 0,
            0x298 /* "we have something in the queue that generates this event" */);

        assert((this.currentBatchClientId === undefined) === (this.pauseSequenceNumber === undefined),
            0x299 /* "non-synchronized state" */);

        const metadata = message.metadata as IRuntimeMessageMetadata;
        const batchMetadata = metadata?.batch;

        // Protocol messages are never part of a runtime batch of messages
        if (!isRuntimeMessage(message)) {
            // Protocol messages should never show up in the middle of the batch!
            assert(this.currentBatchClientId === undefined, 0x29a /* "System message in the middle of batch!" */);
            assert(batchMetadata === undefined, 0x29b /* "system op in a batch?" */);
            assert(!this.localPaused, 0x29c /* "we should be processing ops when there is no active batch" */);
            return;
        }

        if (this.currentBatchClientId === undefined && batchMetadata === undefined) {
            assert(!this.localPaused, 0x29d /* "we should be processing ops when there is no active batch" */);
            return;
        }

        // If the client ID changes then we can move the pause point. If it stayed the same then we need to check.
        // If batchMetadata is not undefined then if it's true we've begun a new batch - if false we've ended
        // the previous one
        if (this.currentBatchClientId !== undefined || batchMetadata === false) {
            if (this.currentBatchClientId !== message.clientId) {
                // "Batch not closed, yet message from another client!"
                throw new DataCorruptionError(
                    "OpBatchIncomplete",
                    {
                        batchClientId: this.currentBatchClientId,
                        ...extractSafePropertiesFromMessage(message),
                    });
            }
        }

        // The queue is
        // 1. paused only when the next message to be processed is the beginning of a batch. Done in two places:
        //    - in afterOpProcessing() - processing ops until reaching start of incomplete batch
        //    - here (batchMetadata == false below), when queue was empty and start of batch showed up.
        // 2. resumed when batch end comes in (batchMetadata === true case below)

        if (batchMetadata) {
            assert(this.currentBatchClientId === undefined, 0x29e /* "there can't be active batch" */);
            assert(!this.localPaused, 0x29f /* "we should be processing ops when there is no active batch" */);
            this.pauseSequenceNumber = message.sequenceNumber;
            this.currentBatchClientId = message.clientId;
            // Start of the batch
            // Only pause processing if queue has no other ops!
            // If there are any other ops in the queue, processing will be stopped when they are processed!
            if (this.deltaManager.inbound.length === 1) {
                this.pauseQueue();
            }
        } else if (batchMetadata === false) {
            assert(this.pauseSequenceNumber !== undefined, 0x2a0 /* "batch presence was validated above" */);
            // Batch is complete, we can process it!
            this.resumeQueue(this.pauseSequenceNumber, message);
            this.pauseSequenceNumber = undefined;
            this.currentBatchClientId = undefined;
        } else {
            // Continuation of current batch. Do nothing
            assert(this.currentBatchClientId !== undefined, 0x2a1 /* "logic error" */);
        }
    }
}

/**
 * This class has the following responsibilities:
 * 1. It tracks batches as we process ops and raises "batchBegin" and "batchEnd" events.
 *    As part of it, it validates batch correctness (i.e. no system ops in the middle of batch)
 * 2. It creates instance of ScheduleManagerCore that ensures we never start processing ops from batch
 *    unless all ops of the batch are in.
 */
export class ScheduleManager {
    private readonly deltaScheduler: DeltaScheduler;
    private batchClientId: string | undefined;
    private hitError = false;

    constructor(
        private readonly deltaManager: IDeltaManager<ISequencedDocumentMessage, IDocumentMessage>,
        private readonly emitter: EventEmitter,
        private readonly logger: ITelemetryLogger,
    ) {
        this.deltaScheduler = new DeltaScheduler(
            this.deltaManager,
            ChildLogger.create(this.logger, "DeltaScheduler"),
        );
        void new ScheduleManagerCore(deltaManager, logger);
    }

    public beforeOpProcessing(message: ISequencedDocumentMessage) {
        if (this.batchClientId !== message.clientId) {
            assert(this.batchClientId === undefined,
                0x2a2 /* "Batch is interrupted by other client op. Should be caught by trackPending()" */);

            // This could be the beginning of a new batch or an individual message.
            this.emitter.emit("batchBegin", message);
            this.deltaScheduler.batchBegin(message);

            const batch = (message?.metadata as IRuntimeMessageMetadata)?.batch;
            if (batch) {
                this.batchClientId = message.clientId;
            } else {
                this.batchClientId = undefined;
            }
        }
    }

    public afterOpProcessing(error: any | undefined, message: ISequencedDocumentMessage) {
        // If this is no longer true, we need to revisit what we do where we set this.hitError.
        assert(!this.hitError, 0x2a3 /* "container should be closed on any error" */);

        if (error) {
            // We assume here that loader will close container and stop processing all future ops.
            // This is implicit dependency. If this flow changes, this code might no longer be correct.
            this.hitError = true;
            this.batchClientId = undefined;
            this.emitter.emit("batchEnd", error, message);
            this.deltaScheduler.batchEnd(message);
            return;
        }

        const batch = (message?.metadata as IRuntimeMessageMetadata)?.batch;
        // If no batchClientId has been set then we're in an individual batch. Else, if we get
        // batch end metadata, this is end of the current batch.
        if (this.batchClientId === undefined || batch === false) {
            this.batchClientId = undefined;
            this.emitter.emit("batchEnd", undefined, message);
            this.deltaScheduler.batchEnd(message);
            return;
        }
    }
}

/**
 * Legacy ID for the built-in AgentScheduler.  To minimize disruption while removing it, retaining this as a
 * special-case for document dirty state.  Ultimately we should have no special-cases from the
 * ContainerRuntime's perspective.
 */
export const agentSchedulerId = "_scheduler";

// safely check navigator and get the hardware spec value
export function getDeviceSpec() {
    try {
        if (typeof navigator === "object" && navigator !== null) {
            return {
                deviceMemory: (navigator as any).deviceMemory,
                hardwareConcurrency: navigator.hardwareConcurrency,
            };
        }
    } catch {
    }
    return {};
}

/**
 * Represents the runtime of the container. Contains helper functions/state of the container.
 * It will define the store level mappings.
 */
export class ContainerRuntime extends TypedEventEmitter<IContainerRuntimeEvents>
    implements
        IContainerRuntime,
        IGarbageCollectionRuntime,
        IRuntime,
        ISummarizerRuntime,
        ISummarizerInternalsProvider {
    public get IContainerRuntime() { return this; }
    public get IFluidRouter() { return this; }

    /**
     * Load the stores from a snapshot and returns the runtime.
     * @param context - Context of the container.
     * @param registryEntries - Mapping to the stores.
     * @param requestHandler - Request handlers for the container runtime
     * @param runtimeOptions - Additional options to be passed to the runtime
     * @param existing - (optional) When loading from an existing snapshot. Precedes context.existing if provided
     */
    public static async load(
        context: IContainerContext,
        registryEntries: NamedFluidDataStoreRegistryEntries,
        requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>,
        runtimeOptions: IContainerRuntimeOptions = {},
        containerScope: FluidObject = context.scope,
        existing?: boolean,
    ): Promise<ContainerRuntime> {
        // If taggedLogger exists, use it. Otherwise, wrap the vanilla logger:
        // back-compat: Remove the TaggedLoggerAdapter fallback once all the host are using loader > 0.45
        const backCompatContext: IContainerContext | OldContainerContextWithLogger = context;
        const passLogger = backCompatContext.taggedLogger ??
            new TaggedLoggerAdapter((backCompatContext as OldContainerContextWithLogger).logger);
        const logger = ChildLogger.create(passLogger, undefined, {
            all: {
                runtimeVersion: pkgVersion,
            },
        });

        const {
            summaryOptions = {},
            gcOptions = {},
            loadSequenceNumberVerification = "close",
            useDataStoreAliasing = false,
            flushMode = defaultFlushMode,
            enableOfflineLoad = false,
        } = runtimeOptions;

        const pendingRuntimeState = context.pendingLocalState as IPendingRuntimeState | undefined;
        const baseSnapshot: ISnapshotTree | undefined = pendingRuntimeState?.baseSnapshot ?? context.baseSnapshot;
        const storage = !pendingRuntimeState ?
            context.storage :
            new SerializedSnapshotStorage(() => { return context.storage; }, pendingRuntimeState.snapshotBlobs);

        const registry = new FluidDataStoreRegistry(registryEntries);

        const tryFetchBlob = async <T>(blobName: string): Promise<T | undefined> => {
            const blobId = baseSnapshot?.blobs[blobName];
            if (baseSnapshot && blobId) {
                // IContainerContext storage api return type still has undefined in 0.39 package version.
                // So once we release 0.40 container-defn package we can remove this check.
                assert(storage !== undefined, 0x1f5 /* "Attached state should have storage" */);
                return readAndParse<T>(storage, blobId);
            }
        };

        const [chunks, metadata, electedSummarizerData, aliases] = await Promise.all([
            tryFetchBlob<[string, string[]][]>(chunksBlobName),
            tryFetchBlob<IContainerRuntimeMetadata>(metadataBlobName),
            tryFetchBlob<ISerializedElection>(electedSummarizerBlobName),
            tryFetchBlob<[string, string][]>(aliasBlobName),
        ]);

        const loadExisting = existing === true || context.existing === true;

        // read snapshot blobs needed for BlobManager to load
        const blobManagerSnapshot = await BlobManager.load(
            baseSnapshot?.trees[blobsTreeName],
            async (id) => {
                // IContainerContext storage api return type still has undefined in 0.39 package version.
                // So once we release 0.40 container-defn package we can remove this check.
                assert(storage !== undefined, 0x256 /* "storage undefined in attached container" */);
                return readAndParse(storage, id);
            },
        );

        // Verify summary runtime sequence number matches protocol sequence number.
        const runtimeSequenceNumber = metadata?.message?.sequenceNumber;
        // When we load with pending state, we reuse an old snapshot so we don't expect these numbers to match
        if (!pendingRuntimeState && runtimeSequenceNumber !== undefined) {
            const protocolSequenceNumber = context.deltaManager.initialSequenceNumber;
            // Unless bypass is explicitly set, then take action when sequence numbers mismatch.
            if (loadSequenceNumberVerification !== "bypass" && runtimeSequenceNumber !== protocolSequenceNumber) {
                // "Load from summary, runtime metadata sequenceNumber !== initialSequenceNumber"
                const error = new DataCorruptionError(
                    // pre-0.58 error message: SummaryMetadataMismatch
                    "Summary metadata mismatch",
                    { runtimeSequenceNumber, protocolSequenceNumber },
                );

                if (loadSequenceNumberVerification === "log") {
                    logger.sendErrorEvent({ eventName: "SequenceNumberMismatch" }, error);
                } else {
                    context.closeFn(error);
                }
            }
        }

        const runtime = new ContainerRuntime(
            context,
            registry,
            metadata,
            electedSummarizerData,
            chunks ?? [],
            aliases ?? [],
            {
                summaryOptions,
                gcOptions,
                loadSequenceNumberVerification,
                useDataStoreAliasing,
                flushMode,
                enableOfflineLoad,
            },
            containerScope,
            logger,
            loadExisting,
            blobManagerSnapshot,
            storage,
            requestHandler,
        );

        if (pendingRuntimeState) {
            await runtime.processSavedOps(pendingRuntimeState);
            // delete these once runtime has seen them to save space
            pendingRuntimeState.savedOps = [];
        }

        await runtime.getSnapshotBlobs();

        return runtime;
    }

    public get options(): ILoaderOptions {
        return this.context.options;
    }

    public get clientId(): string | undefined {
        return this.context.clientId;
    }

    public get clientDetails(): IClientDetails {
        return this.context.clientDetails;
    }

    public get deltaManager(): IDeltaManager<ISequencedDocumentMessage, IDocumentMessage> {
        return this.context.deltaManager;
    }

    public get storage(): IDocumentStorageService {
        return this._storage;
    }

    public get reSubmitFn(): (
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown,
        opMetadata: Record<string, unknown> | undefined,
    ) => void {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        return this.reSubmit;
    }

    public get closeFn(): (error?: ICriticalContainerError) => void {
        return this.context.closeFn;
    }

    public get flushMode(): FlushMode {
        return this._flushMode;
    }

    public get scope(): FluidObject {
        return this.containerScope;
    }

    public get IFluidDataStoreRegistry(): IFluidDataStoreRegistry {
        return this.registry;
    }

    public get attachState(): AttachState {
        return this.context.attachState;
    }

    public get IFluidHandleContext(): IFluidHandleContext {
        return this.handleContext;
    }
    private readonly handleContext: ContainerFluidHandleContext;

    // internal logger for ContainerRuntime. Use this.logger for stores, summaries, etc.
    private readonly mc: MonitoringContext;
    private readonly summarizerClientElection?: SummarizerClientElection;
    /**
     * summaryManager will only be created if this client is permitted to spawn a summarizing client
     * It is created only by interactive client, i.e. summarizer client, as well as non-interactive bots
     * do not create it (see SummarizerClientElection.clientDetailsPermitElection() for details)
     */
    private readonly summaryManager?: SummaryManager;
    private readonly summaryCollection: SummaryCollection;

    private readonly summarizerNode: IRootSummarizerNodeWithGC;
    private readonly _aliasingEnabled: boolean;
    private readonly _maxOpSizeInBytes: number;

    private readonly maxConsecutiveReconnects: number;
    private readonly defaultMaxConsecutiveReconnects = 15;

    private _orderSequentiallyCalls: number = 0;
    private _flushMode: FlushMode;
    private needsFlush = false;
    private flushTrigger = false;

    private _connected: boolean;

    private readonly savedOps: ISequencedDocumentMessage[] = [];
    private baseSnapshotBlobs?: ISerializedBaseSnapshotBlobs;

    private consecutiveReconnects = 0;

    public get connected(): boolean {
        return this._connected;
    }

    /** clientId of parent (non-summarizing) container that owns summarizer container */
    public get summarizerClientId(): string | undefined {
        return this.summarizerClientElection?.electedClientId;
    }

    private _disposed = false;
    public get disposed() { return this._disposed; }

    private dirtyContainer: boolean;
    private emitDirtyDocumentEvent = true;

    private readonly defaultTelemetrySignalSampleCount = 100;
    private _perfSignalData: IPerfSignalReport = {
        signalsLost: 0,
        signalSequenceNumber: 0,
        signalTimestamp: 0,
        trackingSignalSequenceNumber: undefined,
    };

    /**
     * Summarizer is responsible for coordinating when to send generate and send summaries.
     * It is the main entry point for summary work.
     * It is created only by summarizing container (i.e. one with clientType === "summarizer")
     */
    private readonly _summarizer?: Summarizer;
    private readonly deltaSender: IDeltaSender;
    private readonly scheduleManager: ScheduleManager;
    private readonly blobManager: BlobManager;
    private readonly pendingStateManager: PendingStateManager;
    private readonly garbageCollector: IGarbageCollector;

    // Local copy of incomplete received chunks.
    private readonly chunkMap: Map<string, string[]>;

    private readonly dataStores: DataStores;

    /**
     * True if generating summaries with isolated channels is
     * explicitly disabled. This only affects how summaries are written,
     * and is the single source of truth for this container.
     */
    public readonly disableIsolatedChannels: boolean;
    /** The last message processed at the time of the last summary. */
    private messageAtLastSummary: ISummaryMetadataMessage | undefined;

    private get summarizer(): Summarizer {
        assert(this._summarizer !== undefined, 0x257 /* "This is not summarizing container" */);
        return this._summarizer;
    }

    private readonly summariesDisabled: boolean;
    private isSummariesDisabled(): boolean {
        // back-compat: disableSummaries was moved from ISummaryRuntimeOptions
        //   to ISummaryConfiguration in 0.60.
        if (this.runtimeOptions.summaryOptions.disableSummaries === true) {
            return true;
        }
        return this.summaryConfiguration.state === "disabled";
    }

    private readonly heuristicsDisabled: boolean;
    private isHeuristicsDisabled(): boolean {
        // back-compat: disableHeuristics was moved from ISummarizerOptions
        //   to ISummaryConfiguration in 0.60.
        if (this.runtimeOptions.summaryOptions.summarizerOptions?.disableHeuristics === true) {
            return true;
        }
        return this.summaryConfiguration.state === "disableHeuristics";
    }

    private readonly summarizerClientElectionEnabled: boolean;
    private isSummarizerClientElectionEnabled(): boolean {
        if (this.mc.config.getBoolean("Fluid.ContainerRuntime.summarizerClientElection")) {
            return this.mc.config.getBoolean("Fluid.ContainerRuntime.summarizerClientElection") ?? true;
        }
        // back-compat: summarizerClientElection was moved from ISummaryRuntimeOptions
        //   to ISummaryConfiguration in 0.60.
        if (this.runtimeOptions.summaryOptions.summarizerClientElection === true) {
            return true;
        }
        if (this.summaryConfiguration.state !== "disabled") {
            return this.summaryConfiguration.summarizerClientElection === true;
        } else {
            return false;
        }
    }
    private readonly maxOpsSinceLastSummary: number;
    private getMaxOpsSinceLastSummary(): number {
        // back-compat: maxOpsSinceLastSummary was moved from ISummaryRuntimeOptions
        //   to ISummaryConfiguration in 0.60.
        if (this.runtimeOptions.summaryOptions.maxOpsSinceLastSummary !== undefined) {
            return this.runtimeOptions.summaryOptions.maxOpsSinceLastSummary;
        }
        if (this.summaryConfiguration.state !== "disabled") {
            return this.summaryConfiguration.maxOpsSinceLastSummary;
        } else {
            return 0;
        }
    }

    private readonly initialSummarizerDelayMs: number;
    private getInitialSummarizerDelayMs(): number {
        // back-compat: initialSummarizerDelayMs was moved from ISummaryRuntimeOptions
        //   to ISummaryConfiguration in 0.60.
        if (this.runtimeOptions.summaryOptions.initialSummarizerDelayMs !== undefined) {
            return this.runtimeOptions.summaryOptions.initialSummarizerDelayMs;
        }
        if (this.summaryConfiguration.state !== "disabled") {
            return this.summaryConfiguration.initialSummarizerDelayMs;
        } else {
            return 0;
        }
    }

    private readonly createContainerMetadata: ICreateContainerMetadata;
    /**
     * The summary number of the next summary that will be generated for this container. This is incremented every time
     * a summary is generated.
     */
    private nextSummaryNumber: number;
    private readonly opTracker: OpTracker;

    private constructor(
        private readonly context: IContainerContext,
        private readonly registry: IFluidDataStoreRegistry,
        metadata: IContainerRuntimeMetadata | undefined,
        electedSummarizerData: ISerializedElection | undefined,
        chunks: [string, string[]][],
        dataStoreAliasMap: [string, string][],
        private readonly runtimeOptions: Readonly<Required<IContainerRuntimeOptions>>,
        private readonly containerScope: FluidObject,
        public readonly logger: ITelemetryLogger,
        existing: boolean,
        blobManagerSnapshot: IBlobManagerLoadInfo,
        private readonly _storage: IDocumentStorageService,
        private readonly requestHandler?: (request: IRequest, runtime: IContainerRuntime) => Promise<IResponse>,
        private readonly summaryConfiguration: ISummaryConfiguration = {
            // the defaults
            ... DefaultSummaryConfiguration,
            // the runtime configuration overrides
            ... runtimeOptions.summaryOptions?.summaryConfigOverrides,
        },
    ) {
        super();
        this.messageAtLastSummary = metadata?.message;

        // Default to false (enabled).
        this.disableIsolatedChannels = this.runtimeOptions.summaryOptions.disableIsolatedChannels ?? false;

        this._connected = this.context.connected;
        this.chunkMap = new Map<string, string[]>(chunks);

        this.handleContext = new ContainerFluidHandleContext("", this);

        this.mc = loggerToMonitoringContext(
            ChildLogger.create(this.logger, "ContainerRuntime"));

        this.summariesDisabled = this.isSummariesDisabled();
        this.heuristicsDisabled = this.isHeuristicsDisabled();
        this.summarizerClientElectionEnabled = this.isSummarizerClientElectionEnabled();
        this.maxOpsSinceLastSummary = this.getMaxOpsSinceLastSummary();
        this.initialSummarizerDelayMs = this.getInitialSummarizerDelayMs();

        this._aliasingEnabled =
            (this.mc.config.getBoolean(useDataStoreAliasingKey) ?? false) ||
            (runtimeOptions.useDataStoreAliasing ?? false);

        this._maxOpSizeInBytes = (this.mc.config.getNumber(maxOpSizeInBytesKey) ?? defaultMaxOpSizeInBytes);
        this.maxConsecutiveReconnects =
            this.mc.config.getNumber(maxConsecutiveReconnectsKey) ?? this.defaultMaxConsecutiveReconnects;

        this._flushMode = runtimeOptions.flushMode;

        const pendingRuntimeState = context.pendingLocalState as IPendingRuntimeState | undefined;
        const baseSnapshot: ISnapshotTree | undefined = pendingRuntimeState?.baseSnapshot ?? context.baseSnapshot;

        this.garbageCollector = GarbageCollector.create({
            runtime: this,
            gcOptions: this.runtimeOptions.gcOptions,
            baseSnapshot,
            baseLogger: this.mc.logger,
            existing,
            metadata,
            isSummarizerClient: this.context.clientDetails.type === summarizerClientType,
            getNodePackagePath: (nodePath: string) => this.getGCNodePackagePath(nodePath),
            getLastSummaryTimestampMs: () => this.messageAtLastSummary?.timestamp,
            readAndParseBlob: async <T>(id: string) => readAndParse<T>(this.storage, id),
        });

        const loadedFromSequenceNumber = this.deltaManager.initialSequenceNumber;
        this.summarizerNode = createRootSummarizerNodeWithGC(
            ChildLogger.create(this.logger, "SummarizerNode"),
            // Summarize function to call when summarize is called. Summarizer node always tracks summary state.
            async (fullTree: boolean, trackState: boolean, telemetryContext?: ITelemetryContext) =>
                this.summarizeInternal(fullTree, trackState, telemetryContext),
            // Latest change sequence number, no changes since summary applied yet
            loadedFromSequenceNumber,
            // Summary reference sequence number, undefined if no summary yet
            baseSnapshot ? loadedFromSequenceNumber : undefined,
            {
                // Must set to false to prevent sending summary handle which would be pointing to
                // a summary with an older protocol state.
                canReuseHandle: false,
                // Must set to true to throw on any data stores failure that was too severe to be handled.
                // We also are not decoding the base summaries at the root.
                throwOnFailure: true,
                // If GC should not run, let the summarizer node know so that it does not track GC state.
                gcDisabled: !this.garbageCollector.shouldRunGC,
            },
        );

        if (baseSnapshot) {
            this.summarizerNode.loadBaseSummaryWithoutDifferential(baseSnapshot);
        }

        this.dataStores = new DataStores(
            getSummaryForDatastores(baseSnapshot, metadata),
            this,
            (attachMsg) => this.submit(ContainerMessageType.Attach, attachMsg),
            (id: string, createParam: CreateChildSummarizerNodeParam) => (
                    summarizeInternal: SummarizeInternalFn,
                    getGCDataFn: (fullGC?: boolean) => Promise<IGarbageCollectionData>,
                    getBaseGCDetailsFn: () => Promise<IGarbageCollectionDetailsBase>,
                ) => this.summarizerNode.createChild(
                    summarizeInternal,
                    id,
                    createParam,
                    undefined,
                    getGCDataFn,
                    getBaseGCDetailsFn,
                ),
            (id: string) => this.summarizerNode.deleteChild(id),
            this.mc.logger,
            async () => this.garbageCollector.getBaseGCDetails(),
            (path: string, timestampMs: number, packagePath?: readonly string[]) => this.garbageCollector.nodeUpdated(
                path,
                "Changed",
                timestampMs,
                packagePath,
            ),
            new Map<string, string>(dataStoreAliasMap),
            this.garbageCollector.writeDataAtRoot,
        );

        this.blobManager = new BlobManager(
            this.handleContext,
            blobManagerSnapshot,
            () => this.storage,
            (blobId: string) => this.submit(ContainerMessageType.BlobAttach, undefined, undefined, { blobId }),
            (blobPath: string) => this.garbageCollector.nodeUpdated(blobPath, "Loaded"),
            this,
            this.logger,
        );

        this.scheduleManager = new ScheduleManager(
            context.deltaManager,
            this,
            ChildLogger.create(this.logger, "ScheduleManager"),
        );

        this.deltaSender = this.deltaManager;

        this.pendingStateManager = new PendingStateManager(
            {
                applyStashedOp: this.applyStashedOp.bind(this),
                clientId: () => this.clientId,
                close: this.closeFn,
                connected: () => this.connected,
                flush: this.flush.bind(this),
                flushMode: () => this.flushMode,
                reSubmit: this.reSubmit.bind(this),
                rollback: this.rollback.bind(this),
                setFlushMode: (mode) => this.setFlushMode(mode),
            },
            this._flushMode,
            pendingRuntimeState?.pending);

        this.context.quorum.on("removeMember", (clientId: string) => {
            this.clearPartialChunks(clientId);
        });

        this.summaryCollection = new SummaryCollection(this.deltaManager, this.logger);

        this.dirtyContainer = this.context.attachState !== AttachState.Attached
            || this.pendingStateManager.hasPendingMessages();
        this.context.updateDirtyContainerState(this.dirtyContainer);

        if (this.summariesDisabled) {
            this.mc.logger.sendTelemetryEvent({ eventName: "SummariesDisabled" });
        } else {
            const orderedClientLogger = ChildLogger.create(this.logger, "OrderedClientElection");
            const orderedClientCollection = new OrderedClientCollection(
                orderedClientLogger,
                this.context.deltaManager,
                this.context.quorum,
            );
            const orderedClientElectionForSummarizer = new OrderedClientElection(

                orderedClientLogger,
                orderedClientCollection,
                electedSummarizerData ?? this.context.deltaManager.lastSequenceNumber,
                SummarizerClientElection.isClientEligible,
            );

            this.summarizerClientElection = new SummarizerClientElection(
                orderedClientLogger,
                this.summaryCollection,
                orderedClientElectionForSummarizer,
                this.maxOpsSinceLastSummary,
                this.summarizerClientElectionEnabled,
            );

            if (this.context.clientDetails.type === summarizerClientType) {
                this._summarizer = new Summarizer(
                    "/_summarizer",
                    this /* ISummarizerRuntime */,
                    () => this.summaryConfiguration,
                    this /* ISummarizerInternalsProvider */,
                    this.handleContext,
                    this.summaryCollection,
                    async (runtime: IConnectableRuntime) => RunWhileConnectedCoordinator.create(runtime),
                );
            } else if (SummarizerClientElection.clientDetailsPermitElection(this.context.clientDetails)) {
                // Only create a SummaryManager and SummarizerClientElection
                // if summaries are enabled and we are not the summarizer client.
                const defaultAction = () => {
                    if (this.summaryCollection.opsSinceLastAck > this.maxOpsSinceLastSummary) {
                        this.logger.sendErrorEvent({ eventName: "SummaryStatus:Behind" });
                        // unregister default to no log on every op after falling behind
                        // and register summary ack handler to re-register this handler
                        // after successful summary
                        this.summaryCollection.once(MessageType.SummaryAck, () => {
                            this.logger.sendTelemetryEvent({ eventName: "SummaryStatus:CaughtUp" });
                            // we've caught up, so re-register the default action to monitor for
                            // falling behind, and unregister ourself
                            this.summaryCollection.on("default", defaultAction);
                        });
                        this.summaryCollection.off("default", defaultAction);
                    }
                };

                this.summaryCollection.on("default", defaultAction);

                // Create the SummaryManager and mark the initial state
                this.summaryManager = new SummaryManager(
                    this.summarizerClientElection,
                    this, // IConnectedState
                    this.summaryCollection,
                    this.logger,
                    this.formRequestSummarizerFn(this.context.loader),
                    new Throttler(
                        60 * 1000, // 60 sec delay window
                        30 * 1000, // 30 sec max delay
                        // throttling function increases exponentially (0ms, 40ms, 80ms, 160ms, etc)
                        formExponentialFn({ coefficient: 20, initialDelay: 0 }),
                    ),
                    {
                        initialDelayMs: this.initialSummarizerDelayMs,
                    },
                    this.heuristicsDisabled,
                );
                this.summaryManager.start();
            }
        }

        this.deltaManager.on("readonly", (readonly: boolean) => {
            // we accumulate ops while being in read-only state.
            // once user gets write permissions and we have active connection, flush all pending ops.
            assert(readonly === this.deltaManager.readOnlyInfo.readonly,
                0x124 /* "inconsistent readonly property/event state" */);

            // We need to be very careful with when we (re)send pending ops, to ensure that we only send ops
            // when we either never send an op, or attempted to send it but we know for sure it was not
            // sequenced by server and will never be sequenced (i.e. was lost)
            // For loss of connection, we wait for our own "join" op and use it a a barrier to know all the
            // ops that made it from previous connection, before switching clientId and raising "connected" event
            // But with read-only permissions, if we transition between read-only and r/w states while on same
            // connection, then we have no good signal to tell us when it's safe to send ops we accumulated while
            // being in read-only state.
            // For that reason, we support getting to read-only state only when disconnected. This ensures that we
            // can rely on same safety mechanism and resend ops only when we establish new connection.
            // This is applicable for read-only permissions (event is raised before connection is properly registered),
            // but it's an extra requirement for Container.forceReadonly() API
            assert(!readonly || !this.connected, 0x125 /* "Unsafe to transition to read-only state!" */);

            this.replayPendingStates();
        });

        // logging hardware telemetry
        logger.sendTelemetryEvent({
            eventName: "DeviceSpec",
            ...getDeviceSpec(),
        });

        let loadSummaryNumber: number;
        // Get the container creation metadata. For new container, we initialize these. For existing containers,
        // get the values from the metadata blob.
        if (existing) {
            this.createContainerMetadata = {
                createContainerRuntimeVersion: metadata?.createContainerRuntimeVersion,
                createContainerTimestamp: metadata?.createContainerTimestamp,
            };
            // back-compat 0.59.3000 - Older document may either write summaryCount or not write it at all. If it does
            // not write it, initialize summaryNumber to 0.
            loadSummaryNumber = metadata?.summaryNumber ?? metadata?.summaryCount ?? 0;
        } else {
            this.createContainerMetadata = {
                createContainerRuntimeVersion: pkgVersion,
                createContainerTimestamp: Date.now(),
            };
            loadSummaryNumber = 0;
        }
        this.nextSummaryNumber = loadSummaryNumber + 1;

        this.logger.sendTelemetryEvent({
            eventName: "ContainerLoadStats",
            ...this.createContainerMetadata,
            ...this.dataStores.containerLoadStats,
            summaryNumber: loadSummaryNumber,
            summaryFormatVersion: metadata?.summaryFormatVersion,
            disableIsolatedChannels: metadata?.disableIsolatedChannels,
            gcVersion: metadata?.gcFeature,
        });

        ReportOpPerfTelemetry(this.context.clientId, this.deltaManager, this.logger);
        BindBatchTracker(this, this.logger);
        this.opTracker = new OpTracker(this.deltaManager, this.mc.config.getBoolean(disableOpTrackingKey) === true);
    }

    public dispose(error?: Error): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;

        this.logger.sendTelemetryEvent({
            eventName: "ContainerRuntimeDisposed",
            isDirty: this.isDirty,
            lastSequenceNumber: this.deltaManager.lastSequenceNumber,
            attachState: this.attachState,
        }, error);

        if (this.summaryManager !== undefined) {
            this.summaryManager.dispose();
        }
        this.garbageCollector.dispose();
        this._summarizer?.dispose();
        this.dataStores.dispose();
        this.pendingStateManager.dispose();
        this.emit("dispose");
        this.removeAllListeners();
    }

    public get IFluidTokenProvider() {
        if (this.options?.intelligence) {
            // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
            return {
                intelligence: this.options.intelligence,
            } as IFluidTokenProvider;
        }
        return undefined;
    }

    /**
     * Notifies this object about the request made to the container.
     * @param request - Request made to the handler.
     */
    public async request(request: IRequest): Promise<IResponse> {
        try {
            const parser = RequestParser.create(request);
            const id = parser.pathParts[0];

            if (id === "_summarizer" && parser.pathParts.length === 1) {
                if (this._summarizer !== undefined) {
                    return {
                        status: 200,
                        mimeType: "fluid/object",
                        value: this.summarizer,
                    };
                }
                return create404Response(request);
            }
            if (this.requestHandler !== undefined) {
                return this.requestHandler(parser, this);
            }

            return create404Response(request);
        } catch (error) {
            return exceptionToResponse(error);
        }
    }

    /**
     * Resolves URI representing handle
     * @param request - Request made to the handler.
     */
    public async resolveHandle(request: IRequest): Promise<IResponse> {
        try {
            const requestParser = RequestParser.create(request);
            const id = requestParser.pathParts[0];

            if (id === "_channels") {
                return this.resolveHandle(requestParser.createSubRequest(1));
            }

            if (id === BlobManager.basePath && requestParser.isLeaf(2)) {
                const handle = await this.blobManager.getBlob(requestParser.pathParts[1]);
                if (handle) {
                    return {
                        status: 200,
                        mimeType: "fluid/object",
                        value: handle.get(),
                    };
                } else {
                    return create404Response(request);
                }
            } else if (requestParser.pathParts.length > 0) {
                const dataStore = await this.getDataStoreFromRequest(id, request);
                const subRequest = requestParser.createSubRequest(1);
                // We always expect createSubRequest to include a leading slash, but asserting here to protect against
                // unintentionally modifying the url if that changes.
                assert(subRequest.url.startsWith("/"),
                    0x126 /* "Expected createSubRequest url to include a leading slash" */);
                return dataStore.IFluidRouter.request(subRequest);
            }

            return create404Response(request);
        } catch (error) {
            return exceptionToResponse(error);
        }
    }

    private internalId(maybeAlias: string): string {
        return this.dataStores.aliases().get(maybeAlias) ?? maybeAlias;
    }

    private async getDataStoreFromRequest(id: string, request: IRequest): Promise<IFluidRouter> {
        const wait = typeof request.headers?.[RuntimeHeaders.wait] === "boolean"
            ? request.headers?.[RuntimeHeaders.wait]
            : true;

        const internalId = this.internalId(id);
        const dataStoreContext = await this.dataStores.getDataStore(internalId, wait);

        /**
         * If GC should run and this an external app request with "externalRequest" header, we need to return
         * an error if the data store being requested is marked as unreferenced as per the data store's base
         * GC data.
         *
         * This is a workaround to handle scenarios where a data store shared with an external app is deleted
         * and marked as unreferenced by GC. Returning an error will fail to load the data store for the app.
         */
        if (request.headers?.[RuntimeHeaders.externalRequest] && this.garbageCollector.shouldRunGC) {
            // The data store is referenced if used routes in the base summary has a route to self.
            // Older documents may not have used routes in the summary. They are considered referenced.
            const usedRoutes = (await dataStoreContext.getBaseGCDetails()).usedRoutes;
            if (!(usedRoutes === undefined || usedRoutes.includes("") || usedRoutes.includes("/"))) {
                throw responseToException(create404Response(request), request);
            }
        }

        const dataStoreChannel = await dataStoreContext.realize();

        // Remove query params, leading and trailing slashes from the url. This is done to make sure the format is
        // the same as GC nodes id.
        const urlWithoutQuery = trimLeadingAndTrailingSlashes(request.url.split("?")[0]);
        this.garbageCollector.nodeUpdated(
            `/${urlWithoutQuery}`,
            "Loaded",
            undefined /* timestampMs */,
            dataStoreContext.packagePath,
            request?.headers,
        );
        return dataStoreChannel;
    }

    /** Adds the container's metadata to the given summary tree. */
    private addMetadataToSummary(summaryTree: ISummaryTreeWithStats) {
        const metadata: IContainerRuntimeMetadata = {
            ...this.createContainerMetadata,
            // back-compat 0.59.3000: This is renamed to summaryNumber. Can be removed when 0.59.3000 saturates.
            summaryCount: this.nextSummaryNumber,
            // Increment the summary number for the next summary that will be generated.
            summaryNumber: this.nextSummaryNumber++,
            summaryFormatVersion: 1,
            disableIsolatedChannels: this.disableIsolatedChannels || undefined,
            ...this.garbageCollector.getMetadata(),
            // The last message processed at the time of summary. If there are no new messages, use the message from the
            // last summary.
            message: extractSummaryMetadataMessage(this.deltaManager.lastMessage) ?? this.messageAtLastSummary,
        };
        addBlobToSummary(summaryTree, metadataBlobName, JSON.stringify(metadata));
    }

    private addContainerStateToSummary(
        summaryTree: ISummaryTreeWithStats,
        fullTree: boolean,
        trackState: boolean,
        telemetryContext?: ITelemetryContext,
    ) {
        this.addMetadataToSummary(summaryTree);

        if (this.chunkMap.size > 0) {
            const content = JSON.stringify([...this.chunkMap]);
            addBlobToSummary(summaryTree, chunksBlobName, content);
        }

        const dataStoreAliases = this.dataStores.aliases();
        if (dataStoreAliases.size > 0) {
            addBlobToSummary(summaryTree, aliasBlobName, JSON.stringify([...dataStoreAliases]));
        }

        if (this.summarizerClientElection) {
            const electedSummarizerContent = JSON.stringify(this.summarizerClientElection?.serialize());
            addBlobToSummary(summaryTree, electedSummarizerBlobName, electedSummarizerContent);
        }

        const blobManagerSummary = this.blobManager.summarize();
        // Some storage (like git) doesn't allow empty tree, so we can omit it.
        // and the blob manager can handle the tree not existing when loading
        if (Object.keys(blobManagerSummary.summary.tree).length > 0) {
            addTreeToSummary(summaryTree, blobsTreeName, blobManagerSummary);
        }

        if (this.garbageCollector.writeDataAtRoot) {
            const gcSummary = this.garbageCollector.summarize(fullTree, trackState, telemetryContext);
            if (gcSummary !== undefined) {
                addSummarizeResultToSummary(summaryTree, gcTreeKey, gcSummary);
            }
        }
    }

    // Track how many times the container tries to reconnect with pending messages.
    // This happens when the connection state is changed and we reset the counter
    // when we are able to process a local op or when there are no pending messages.
    // If this counter reaches a max, it's a good indicator that the container
    // is not making progress and it is stuck in a retry loop.
    private shouldContinueReconnecting(): boolean {
        if (this.maxConsecutiveReconnects <= 0) {
            // Feature disabled, we never stop reconnecting
            return true;
        }

        if (!this.pendingStateManager.hasPendingMessages()) {
            // If there are no pending messages, we can always reconnect
            this.resetReconnectCount();
            return true;
        }

        if (this.consecutiveReconnects === Math.floor(this.maxConsecutiveReconnects / 2)) {
            // If we're halfway through the max reconnects, send an event in order
            // to better identify false positives, if any. If the rate of this event
            // matches Container Close count below, we can safely cut down
            // maxConsecutiveReconnects to half.
            this.mc.logger.sendTelemetryEvent({
                eventName: "ReconnectsWithNoProgress",
                attempts: this.consecutiveReconnects,
                pendingMessages: this.pendingStateManager.pendingMessagesCount,
            });
        }

        return this.consecutiveReconnects < this.maxConsecutiveReconnects;
    }

    private resetReconnectCount() {
        this.consecutiveReconnects = 0;
    }

    private replayPendingStates() {
        // We need to be able to send ops to replay states
        if (!this.canSendOps()) { return; }

        // We need to temporary clear the dirty flags and disable
        // dirty state change events to detect whether replaying ops
        // has any effect.

        // Save the old state, reset to false, disable event emit
        const oldState = this.dirtyContainer;
        this.dirtyContainer = false;

        assert(this.emitDirtyDocumentEvent, 0x127 /* "dirty document event not set on replay" */);
        this.emitDirtyDocumentEvent = false;
        let newState: boolean;

        try {
            // replay the ops
            this.pendingStateManager.replayPendingStates();
        } finally {
            // Save the new start and restore the old state, re-enable event emit
            newState = this.dirtyContainer;
            this.dirtyContainer = oldState;
            this.emitDirtyDocumentEvent = true;
        }

        // Officially transition from the old state to the new state.
        this.updateDocumentDirtyState(newState);
    }

    private async applyStashedOp(type: ContainerMessageType, op: ISequencedDocumentMessage): Promise<unknown> {
        switch (type) {
            case ContainerMessageType.FluidDataStoreOp:
                return this.dataStores.applyStashedOp(op);
            case ContainerMessageType.Attach:
                return this.dataStores.applyStashedAttachOp(op as unknown as IAttachMessage);
            case ContainerMessageType.Alias:
            case ContainerMessageType.BlobAttach:
                return;
            case ContainerMessageType.ChunkedOp:
                throw new Error("chunkedOp not expected here");
            case ContainerMessageType.Rejoin:
                throw new Error("rejoin not expected here");
            default:
                unreachableCase(type, `Unknown ContainerMessageType: ${type}`);
        }
    }

    public setConnectionState(connected: boolean, clientId?: string) {
        this.verifyNotClosed();

        // There might be no change of state due to Container calling this API after loading runtime.
        const changeOfState = this._connected !== connected;
        const reconnection = changeOfState && connected;
        this._connected = connected;

        if (!connected) {
            this._perfSignalData.signalsLost = 0;
            this._perfSignalData.signalTimestamp = 0;
            this._perfSignalData.trackingSignalSequenceNumber = undefined;
        }

        if (reconnection) {
            this.consecutiveReconnects++;

            if (!this.shouldContinueReconnecting()) {
                this.closeFn(
                    // pre-0.58 error message: MaxReconnectsWithNoProgress
                    DataProcessingError.create(
                        "Runtime detected too many reconnects with no progress syncing local ops",
                        "setConnectionState",
                        undefined,
                       {
                        dataLoss: 1,
                        attempts: this.consecutiveReconnects,
                        pendingMessages: this.pendingStateManager.pendingMessagesCount,
                    }));
                return;
            }
        }

        if (changeOfState) {
            this.replayPendingStates();
        }

        this.dataStores.setConnectionState(connected, clientId);

        raiseConnectedEvent(this.mc.logger, this, connected, clientId);
    }

    public process(messageArg: ISequencedDocumentMessage, local: boolean) {
        this.verifyNotClosed();

        // If it's not message for runtime, bail out right away.
        if (!isRuntimeMessage(messageArg)) {
            return;
        }

        if (this.mc.config.getBoolean("enableOfflineLoad") ?? this.runtimeOptions.enableOfflineLoad) {
            this.savedOps.push(messageArg);
        }

        // Do shallow copy of message, as methods below will modify it.
        // There might be multiple container instances receiving same message
        // We do not need to make deep copy, as each layer will just replace message.content itself,
        // but would not modify contents details
        let message = { ...messageArg };

        // Surround the actual processing of the operation with messages to the schedule manager indicating
        // the beginning and end. This allows it to emit appropriate events and/or pause the processing of new
        // messages once a batch has been fully processed.
        this.scheduleManager.beforeOpProcessing(message);

        try {
            message = unpackRuntimeMessage(message);

            // Chunk processing must come first given that we will transform the message to the unchunked version
            // once all pieces are available
            message = this.processRemoteChunkedMessage(message);

            let localOpMetadata: unknown;
            if (local) {
                // Call the PendingStateManager to process local messages.
                // Do not process local chunked ops until all pieces are available.
                if (message.type !== ContainerMessageType.ChunkedOp) {
                    localOpMetadata = this.pendingStateManager.processPendingLocalMessage(message);
                }
            }

            // If there are no more pending messages after processing a local message,
            // the document is no longer dirty.
            if (!this.pendingStateManager.hasPendingMessages()) {
                this.updateDocumentDirtyState(false);
            }

            switch (message.type) {
                case ContainerMessageType.Attach:
                    this.dataStores.processAttachMessage(message, local);
                    break;
                case ContainerMessageType.Alias:
                    this.processAliasMessage(message, localOpMetadata, local);
                    break;
                case ContainerMessageType.FluidDataStoreOp:
                    this.dataStores.processFluidDataStoreOp(message, local, localOpMetadata);
                    break;
                case ContainerMessageType.BlobAttach:
                    assert(message?.metadata?.blobId, 0x12a /* "Missing blob id on metadata" */);
                    this.blobManager.processBlobAttachOp(message.metadata.blobId, local);
                    break;
                default:
            }

            this.emit("op", message);
            this.scheduleManager.afterOpProcessing(undefined, message);

            if (local) {
                // If we have processed a local op, this means that the container is
                // making progress and we can reset the counter for how many times
                // we have consecutively replayed the pending states
                this.resetReconnectCount();
            }
        } catch (e) {
            this.scheduleManager.afterOpProcessing(e, message);
            throw e;
        }
    }

    private processAliasMessage(
        message: ISequencedDocumentMessage,
        localOpMetadata: unknown,
        local: boolean,
    ) {
        this.dataStores.processAliasMessage(message, localOpMetadata, local);
    }

    /**
     * Emits the Signal event and update the perf signal data.
     * @param clientSignalSequenceNumber - is the client signal sequence number to be uploaded.
     */
    private sendSignalTelemetryEvent(clientSignalSequenceNumber: number) {
        const duration = Date.now() - this._perfSignalData.signalTimestamp;
        this.logger.sendPerformanceEvent({
            eventName: "SignalLatency",
            duration,
            signalsLost: this._perfSignalData.signalsLost,
        });

        this._perfSignalData.signalsLost = 0;
        this._perfSignalData.signalTimestamp = 0;
    }

    public processSignal(message: ISignalMessage, local: boolean) {
        const envelope = message.content as ISignalEnvelope;
        const transformed: IInboundSignalMessage = {
            clientId: message.clientId,
            content: envelope.contents.content,
            type: envelope.contents.type,
        };

        // Only collect signal telemetry for messages sent by the current client.
        if (message.clientId === this.clientId && this.connected) {
            // Check to see if the signal was lost.
            if (this._perfSignalData.trackingSignalSequenceNumber !== undefined &&
                envelope.clientSignalSequenceNumber > this._perfSignalData.trackingSignalSequenceNumber) {
                this._perfSignalData.signalsLost++;
                this._perfSignalData.trackingSignalSequenceNumber = undefined;
                this.logger.sendErrorEvent({
                    eventName: "SignalLost",
                    type: envelope.contents.type,
                    signalsLost: this._perfSignalData.signalsLost,
                    trackingSequenceNumber: this._perfSignalData.trackingSignalSequenceNumber,
                    clientSignalSequenceNumber: envelope.clientSignalSequenceNumber,
                });
            } else if (envelope.clientSignalSequenceNumber === this._perfSignalData.trackingSignalSequenceNumber) {
                this.sendSignalTelemetryEvent(envelope.clientSignalSequenceNumber);
                this._perfSignalData.trackingSignalSequenceNumber = undefined;
            }
        }

        if (envelope.address === undefined) {
            // No address indicates a container signal message.
            this.emit("signal", transformed, local);
            return;
        }

        this.dataStores.processSignal(envelope.address, transformed, local);
    }

    public async getRootDataStore(id: string, wait = true): Promise<IFluidRouter> {
        const internalId = this.internalId(id);
        const context = await this.dataStores.getDataStore(internalId, wait);
        assert(await context.isRoot(), 0x12b /* "did not get root data store" */);
        return context.realize();
    }

    public setFlushMode(mode: FlushMode): void {
        if (mode === this._flushMode) {
            return;
        }

        this.mc.logger.sendTelemetryEvent({
            eventName: "FlushMode Updated",
            old: this._flushMode,
            new: mode,
        });

        // Flush any pending batches if switching to immediate
        if (mode === FlushMode.Immediate) {
            this.flush();
        }

        this._flushMode = mode;

        // Let the PendingStateManager know that FlushMode has been updated.
        this.pendingStateManager.onFlushModeUpdated(mode);
    }

    public flush(): void {
        assert(this._orderSequentiallyCalls === 0,
            0x24c /* "Cannot call `flush()` from `orderSequentially`'s callback" */);

        if (!this.deltaSender) {
            return;
        }

        // Let the PendingStateManager know that there was an attempt to flush messages.
        // Note that this should happen before the `this.needsFlush` check below because in the scenario where we are
        // not connected, `this.needsFlush` will be false but the PendingStateManager might have pending messages and
        // hence needs to track this.
        this.pendingStateManager.onFlush();

        // If flush has already been called then exit early
        if (!this.needsFlush) {
            return;
        }

        this.needsFlush = false;

        // Did we disconnect in the middle of turn-based batch?
        // If so, do nothing, as pending state manager will resubmit it correctly on reconnect.
        if (!this.canSendOps()) {
            return;
        }

        return this.deltaSender.flush();
    }

    public orderSequentially(callback: () => void): void {
        // If flush mode is already TurnBased we are either
        // nested in another orderSequentially, or
        // the app is flushing manually, in which
        // case this invocation doesn't own
        // flushing.
        if (this.flushMode === FlushMode.TurnBased) {
            this.trackOrderSequentiallyCalls(callback);
            return;
        }

        const savedFlushMode = this.flushMode;
        this.setFlushMode(FlushMode.TurnBased);

        try {
            this.trackOrderSequentiallyCalls(callback);
            this.flush();
        } finally {
            this.setFlushMode(savedFlushMode);
        }
    }

    private trackOrderSequentiallyCalls(callback: () => void): void {
        let checkpoint: { rollback: () => void; } | undefined;
        if (this.mc.config.getBoolean("Fluid.ContainerRuntime.EnableRollback")) {
            checkpoint = this.pendingStateManager.checkpoint();
        }

        try {
            this._orderSequentiallyCalls++;
            callback();
        } catch (error) {
            if (checkpoint) {
                // This will throw and close the container if rollback fails
                checkpoint.rollback();
            } else {
                // pre-0.58 error message: orderSequentiallyCallbackException
                this.closeFn(new GenericError("orderSequentially callback exception", error));
            }
            throw error; // throw the original error for the consumer of the runtime
        } finally {
            this._orderSequentiallyCalls--;
        }
    }

    public async createDataStore(pkg: string | string[]): Promise<IDataStore> {
        const internalId = uuid();
        return channelToDataStore(
            await this._createDataStore(pkg, false /* isRoot */, internalId),
            internalId,
            this,
            this.dataStores,
            this.mc.logger);
    }

    /**
     * Creates a root datastore directly with a user generated id and attaches it to storage.
     * It is vulnerable to name collisions and should not be used.
     *
     * This method will be removed. See #6465.
     */
    private async createRootDataStoreLegacy(pkg: string | string[], rootDataStoreId: string): Promise<IFluidRouter> {
        const fluidDataStore = await this._createDataStore(pkg, true /* isRoot */, rootDataStoreId);
        // back-compat 0.59.1000 - makeVisibleAndAttachGraph was added in this version to IFluidDataStoreChannel. For
        // older versions, we still have to call bindToContext.
        if (fluidDataStore.makeVisibleAndAttachGraph !== undefined) {
            fluidDataStore.makeVisibleAndAttachGraph();
        } else {
            fluidDataStore.bindToContext();
        }
        return fluidDataStore;
    }

    /**
     * @deprecated - will be removed in an upcoming release. See #9660.
     */
    public async createRootDataStore(pkg: string | string[], rootDataStoreId: string): Promise<IFluidRouter> {
        if (rootDataStoreId.includes("/")) {
            throw new UsageError(`Id cannot contain slashes: '${rootDataStoreId}'`);
        }
        return this._aliasingEnabled === true ?
            this.createAndAliasDataStore(pkg, rootDataStoreId) :
            this.createRootDataStoreLegacy(pkg, rootDataStoreId);
    }

    /**
     * Creates a data store then attempts to alias it.
     * If aliasing fails, it will raise an exception.
     *
     * This method will be removed. See #6465.
     *
     * @param pkg - Package name of the data store
     * @param alias - Alias to be assigned to the data store
     * @param props - Properties for the data store
     * @returns - An aliased data store which can can be found / loaded by alias.
     */
    private async createAndAliasDataStore(pkg: string | string[], alias: string, props?: any): Promise<IDataStore> {
        const internalId = uuid();
        const dataStore = await this._createDataStore(pkg, false /* isRoot */, internalId, props);
        const aliasedDataStore = channelToDataStore(dataStore, internalId, this, this.dataStores, this.mc.logger);
        const result = await aliasedDataStore.trySetAlias(alias);
        if (result !== "Success") {
            throw new GenericError(
                "dataStoreAliasFailure",
                undefined /* error */,
                {
                    alias: {
                        value: alias,
                        tag: TelemetryDataTag.UserData,
                    },
                    internalId: {
                        value: internalId,
                        tag: TelemetryDataTag.PackageData,
                    },
                    aliasResult: result,
                });
        }

        return aliasedDataStore;
    }

    public createDetachedRootDataStore(
        pkg: Readonly<string[]>,
        rootDataStoreId: string): IFluidDataStoreContextDetached {
        if (rootDataStoreId.includes("/")) {
            throw new UsageError(`Id cannot contain slashes: '${rootDataStoreId}'`);
        }
        return this.dataStores.createDetachedDataStoreCore(pkg, true, rootDataStoreId);
    }

    public createDetachedDataStore(pkg: Readonly<string[]>): IFluidDataStoreContextDetached {
        return this.dataStores.createDetachedDataStoreCore(pkg, false);
    }

    /**
     * Creates a possibly root datastore directly with a possibly user generated id and attaches it to storage.
     * It is vulnerable to name collisions if both aforementioned conditions are true, and should not be used.
     *
     * This method will be removed. See #6465.
     */
    private async _createDataStoreWithPropsLegacy(
        pkg: string | string[],
        props?: any,
        id = uuid(),
        isRoot = false,
    ): Promise<IDataStore> {
        const fluidDataStore = await this.dataStores._createFluidDataStoreContext(
            Array.isArray(pkg) ? pkg : [pkg], id, isRoot, props).realize();
        if (isRoot) {
            // back-compat 0.59.1000 - makeVisibleAndAttachGraph was added in this version to IFluidDataStoreChannel.
            // For older versions, we still have to call bindToContext.
            if (fluidDataStore.makeVisibleAndAttachGraph !== undefined) {
                fluidDataStore.makeVisibleAndAttachGraph();
            } else {
                fluidDataStore.bindToContext();
            }
            this.logger.sendTelemetryEvent({
                eventName: "Root datastore with props",
                hasProps: props !== undefined,
            });
        }
        return channelToDataStore(fluidDataStore, id, this, this.dataStores, this.mc.logger);
    }

    public async _createDataStoreWithProps(
        pkg: string | string[],
        props?: any,
        id = uuid(),
        isRoot = false,
    ): Promise<IDataStore> {
        return this._aliasingEnabled === true && isRoot ?
            this.createAndAliasDataStore(pkg, id, props) :
            this._createDataStoreWithPropsLegacy(pkg, props, id, isRoot);
    }

    private async _createDataStore(
        pkg: string | string[],
        isRoot: boolean,
        id = uuid(),
        props?: any,
    ): Promise<IFluidDataStoreChannel> {
        return this.dataStores
            ._createFluidDataStoreContext(Array.isArray(pkg) ? pkg : [pkg], id, isRoot, props)
            .realize();
    }

    private canSendOps() {
        return this.connected && !this.deltaManager.readOnlyInfo.readonly;
    }

    public getQuorum(): IQuorumClients {
        return this.context.quorum;
    }

    public getAudience(): IAudience {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        return this.context.audience!;
    }

    /**
     * Returns true of container is dirty, i.e. there are some pending local changes that
     * either were not sent out to delta stream or were not yet acknowledged.
     */
    public get isDirty(): boolean {
        return this.dirtyContainer;
    }

    private isContainerMessageDirtyable(type: ContainerMessageType, contents: any) {
        // For legacy purposes, exclude the old built-in AgentScheduler from dirty consideration as a special-case.
        // Ultimately we should have no special-cases from the ContainerRuntime's perspective.
        if (type === ContainerMessageType.Attach) {
            const attachMessage = contents as InboundAttachMessage;
            if (attachMessage.id === agentSchedulerId) {
                return false;
            }
        } else if (type === ContainerMessageType.FluidDataStoreOp) {
            const envelope = contents as IEnvelope;
            if (envelope.address === agentSchedulerId) {
                return false;
            }
        }
        return true;
    }

    private createNewSignalEnvelope(address: string | undefined, type: string, content: any): ISignalEnvelope {
        const newSequenceNumber = ++this._perfSignalData.signalSequenceNumber;
        const newEnvelope: ISignalEnvelope = {
            address,
            clientSignalSequenceNumber: newSequenceNumber,
            contents: { type, content },
        };

        // We should not track any signals in case we already have a tracking number.
        if (newSequenceNumber % this.defaultTelemetrySignalSampleCount === 1 &&
            this._perfSignalData.trackingSignalSequenceNumber === undefined) {
            this._perfSignalData.signalTimestamp = Date.now();
            this._perfSignalData.trackingSignalSequenceNumber = newSequenceNumber;
        }

        return newEnvelope;
    }

    /**
     * Submits the signal to be sent to other clients.
     * @param type - Type of the signal.
     * @param content - Content of the signal.
     */
    public submitSignal(type: string, content: any) {
        this.verifyNotClosed();
        const envelope = this.createNewSignalEnvelope(undefined /* address */, type, content);
        return this.context.submitSignalFn(envelope);
    }

    public submitDataStoreSignal(address: string, type: string, content: any) {
        const envelope = this.createNewSignalEnvelope(address, type, content);
         return this.context.submitSignalFn(envelope);
    }

    public setAttachState(attachState: AttachState.Attaching | AttachState.Attached): void {
        if (attachState === AttachState.Attaching) {
            assert(this.attachState === AttachState.Attaching,
                0x12d /* "Container Context should already be in attaching state" */);
        } else {
            assert(this.attachState === AttachState.Attached,
                0x12e /* "Container Context should already be in attached state" */);
            this.emit("attached");
        }

        if (attachState === AttachState.Attached && !this.pendingStateManager.hasPendingMessages()) {
            this.updateDocumentDirtyState(false);
        }
        this.dataStores.setAttachState(attachState);
    }

    /**
     * Create a summary. Used when attaching or serializing a detached container.
     *
     * @param blobRedirectTable - A table passed during the attach process. While detached, blob upload is supported
     * using IDs generated locally. After attach, these IDs cannot be used, so this table maps the old local IDs to the
     * new storage IDs so requests can be redirected.
     * @param telemetryContext - summary data passed through the layers for telemetry purposes
     */
    public createSummary(blobRedirectTable?: Map<string, string>, telemetryContext?: ITelemetryContext): ISummaryTree {
        if (blobRedirectTable) {
            this.blobManager.setRedirectTable(blobRedirectTable);
        }

        const summarizeResult = this.dataStores.createSummary(telemetryContext);
        if (!this.disableIsolatedChannels) {
            // Wrap data store summaries in .channels subtree.
            wrapSummaryInChannelsTree(summarizeResult);
        }
        this.addContainerStateToSummary(
            summarizeResult,
            true /* fullTree */,
            false /* trackState */,
            telemetryContext,
        );
        return summarizeResult.summary;
    }

    public async getAbsoluteUrl(relativeUrl: string): Promise<string | undefined> {
        if (this.context.getAbsoluteUrl === undefined) {
            throw new Error("Driver does not implement getAbsoluteUrl");
        }
        if (this.attachState !== AttachState.Attached) {
            return undefined;
        }
        return this.context.getAbsoluteUrl(relativeUrl);
    }

    private async summarizeInternal(
        fullTree: boolean,
        trackState: boolean,
        telemetryContext?: ITelemetryContext,
    ): Promise<ISummarizeInternalResult> {
        const summarizeResult = await this.dataStores.summarize(fullTree, trackState, telemetryContext);
        let pathPartsForChildren: string[] | undefined;

        if (!this.disableIsolatedChannels) {
            // Wrap data store summaries in .channels subtree.
            wrapSummaryInChannelsTree(summarizeResult);
            pathPartsForChildren = [channelsTreeName];
        }
        this.addContainerStateToSummary(summarizeResult, fullTree, trackState, telemetryContext);
        return {
            ...summarizeResult,
            id: "",
            pathPartsForChildren,
        };
    }

    /**
     * Returns a summary of the runtime at the current sequence number.
     */
    public async summarize(options: {
        /** True to generate the full tree with no handle reuse optimizations; defaults to false */
        fullTree?: boolean;
        /** True to track the state for this summary in the SummarizerNodes; defaults to true */
        trackState?: boolean;
        /** Logger to use for correlated summary events */
        summaryLogger?: ITelemetryLogger;
        /** True to run garbage collection before summarizing; defaults to true */
        runGC?: boolean;
        /** True to generate full GC data */
        fullGC?: boolean;
        /** True to run GC sweep phase after the mark phase */
        runSweep?: boolean;
    }): Promise<IRootSummaryTreeWithStats> {
        this.verifyNotClosed();

        const {
            fullTree = false,
            trackState = true,
            summaryLogger = this.logger,
            runGC = this.garbageCollector.shouldRunGC,
            runSweep,
            fullGC,
        } = options;

        let gcStats: IGCStats | undefined;
        if (runGC) {
            gcStats = await this.collectGarbage({ logger: summaryLogger, runSweep, fullGC });
        }

        const telemetryContext = new TelemetryContext();
        const { stats, summary } = await this.summarizerNode.summarize(fullTree, trackState, telemetryContext);

        this.logger.sendTelemetryEvent({ eventName: "SummarizeTelemetry", details: telemetryContext.serialize() });

        assert(summary.type === SummaryType.Tree,
            0x12f /* "Container Runtime's summarize should always return a tree" */);

        return { stats, summary, gcStats };
    }

    /**
     * Implementation of IGarbageCollectionRuntime::updateStateBeforeGC.
     * Before GC runs, called by the garbage collector to update any pending GC state. This is mainly used to notify
     * the garbage collector of references detected since the last GC run. Most references are notified immediately
     * but there can be some for which async operation is required (such as detecting new root data stores).
     */
    public async updateStateBeforeGC() {
        return this.dataStores.updateStateBeforeGC();
    }

    /**
     * Implementation of IGarbageCollectionRuntime::getGCData.
     * Generates and returns the GC data for this container.
     * @param fullGC - true to bypass optimizations and force full generation of GC data.
     */
    public async getGCData(fullGC?: boolean): Promise<IGarbageCollectionData> {
        const builder = new GCDataBuilder();
        const dsGCData = await this.dataStores.getGCData(fullGC);
        builder.addNodes(dsGCData.gcNodes);

        const blobsGCData = this.blobManager.getGCData(fullGC);
        builder.addNodes(blobsGCData.gcNodes);
        return builder.getGCData();
    }

    /**
     * Implementation of IGarbageCollectionRuntime::updateUsedRoutes.
     * After GC has run, called to notify this container's nodes of routes that are used in it.
     * @param usedRoutes - The routes that are used in all nodes in this Container.
     * @param gcTimestamp - The time when GC was run that generated these used routes. If any node node becomes
     * unreferenced as part of this GC run, this should be used to update the time when it happens.
     */
    public updateUsedRoutes(usedRoutes: string[], gcTimestamp?: number) {
        // Update our summarizer node's used routes. Updating used routes in summarizer node before
        // summarizing is required and asserted by the the summarizer node. We are the root and are
        // always referenced, so the used routes is only self-route (empty string).
        this.summarizerNode.updateUsedRoutes([""]);

        const dataStoreUsedRoutes: string[] = [];
        for (const route of usedRoutes) {
            if (route.split("/")[1] !== BlobManager.basePath) {
                dataStoreUsedRoutes.push(route);
            }
        }

        return this.dataStores.updateUsedRoutes(dataStoreUsedRoutes, gcTimestamp);
    }

    /**
     * When running GC in test mode, this is called to delete objects whose routes are unused. This enables testing
     * scenarios with accessing deleted content.
     * @param unusedRoutes - The routes that are unused in all data stores in this Container.
     */
    public deleteUnusedRoutes(unusedRoutes: string[]) {
        const blobManagerUnusedRoutes: string[] = [];
        const dataStoreUnusedRoutes: string[] = [];
        for (const route of unusedRoutes) {
            if (this.isBlobPath(route)) {
                blobManagerUnusedRoutes.push(route);
            } else {
                dataStoreUnusedRoutes.push(route);
            }
        }

        this.blobManager.deleteUnusedRoutes(blobManagerUnusedRoutes);
        this.dataStores.deleteUnusedRoutes(dataStoreUnusedRoutes);
    }

    /**
     * Returns a server generated referenced timestamp to be used to track unreferenced nodes by GC.
     */
    public getCurrentReferenceTimestampMs(): number | undefined {
        // Use the timestamp of the last message seen by this client as that is server generated. If no messages have
        // been processed, use the timestamp of the message from the last summary.
        return this.deltaManager.lastMessage?.timestamp ?? this.messageAtLastSummary?.timestamp;
    }

    /**
     * Returns the type of the GC node. Currently, there are nodes that belong to the root ("/"), data stores or
     * blob manager.
     */
    public getNodeType(nodePath: string): GCNodeType {
        if (this.isBlobPath(nodePath)) {
            return GCNodeType.Blob;
        }
        return this.dataStores.getGCNodeType(nodePath) ?? GCNodeType.Other;
    }

    /**
     * Called by GC to retrieve the package path of the node with the given path. The node should belong to a
     * data store or an attachment blob.
     */
    public getGCNodePackagePath(nodePath: string): readonly string[] | undefined {
        switch (this.getNodeType(nodePath)) {
            case GCNodeType.Blob:
                return ["_blobs"];
            case GCNodeType.DataStore:
            case GCNodeType.SubDataStore:
                return this.dataStores.getDataStorePackagePath(nodePath);
            default:
                assert(false, 0x2de /* "Package path requested for unsupported node type." */);
        }
    }

    /**
     * Returns whether a given path is for attachment blobs that are in the format - "/BlobManager.basePath/...".
     */
    private isBlobPath(path: string): boolean {
        const pathParts = path.split("/");
        if (pathParts.length < 2 || pathParts[1] !== BlobManager.basePath) {
            return false;
        }
        return true;
    }

    /**
     * Runs garbage collection and updates the reference / used state of the nodes in the container.
     * @returns the statistics of the garbage collection run.
     */
    public async collectGarbage(
        options: {
            /** Logger to use for logging GC events */
            logger?: ITelemetryLogger;
            /** True to run GC sweep phase after the mark phase */
            runSweep?: boolean;
            /** True to generate full GC data */
            fullGC?: boolean;
        },
    ): Promise<IGCStats> {
        return this.garbageCollector.collectGarbage(options);
    }

    /**
     * Called when a new outbound reference is added to another node. This is used by garbage collection to identify
     * all references added in the system.
     * @param srcHandle - The handle of the node that added the reference.
     * @param outboundHandle - The handle of the outbound node that is referenced.
     */
    public addedGCOutboundReference(srcHandle: IFluidHandle, outboundHandle: IFluidHandle) {
        this.garbageCollector.addedOutboundReference(srcHandle.absolutePath, outboundHandle.absolutePath);
    }

    /**
     * Generates the summary tree, uploads it to storage, and then submits the summarize op.
     * This is intended to be called by the summarizer, since it is the implementation of
     * ISummarizerInternalsProvider.submitSummary.
     * It takes care of state management at the container level, including pausing inbound
     * op processing, updating SummarizerNode state tracking, and garbage collection.
     * @param options - options controlling how the summary is generated or submitted
     */
    public async submitSummary(options: ISubmitSummaryOptions): Promise<SubmitSummaryResult> {
        const { fullTree, refreshLatestAck, summaryLogger } = options;
        // The summary number for this summary. This will be updated during the summary process, so get it now and
        // use it for all events logged during this summary.
        const summaryNumber = this.nextSummaryNumber;
        const summaryNumberLogger = ChildLogger.create(
            summaryLogger,
            undefined,
            {
                all: { summaryNumber },
            },
        );

        if (refreshLatestAck) {
            const latestSummaryRefSeq = await this.refreshLatestSummaryAckFromServer(
                ChildLogger.create(summaryNumberLogger, undefined, { all: { safeSummary: true } }));

            if (latestSummaryRefSeq > this.deltaManager.lastSequenceNumber) {
                // We need to catch up to the latest summary's reference sequence number before pausing.
                await PerformanceEvent.timedExecAsync(
                    summaryNumberLogger,
                    {
                        eventName: "WaitingForSeq",
                        lastSequenceNumber: this.deltaManager.lastSequenceNumber,
                        targetSequenceNumber: latestSummaryRefSeq,
                        lastKnownSeqNumber: this.deltaManager.lastKnownSeqNumber,
                    },
                    async () => waitForSeq(this.deltaManager, latestSummaryRefSeq),
                    { start: true, end: true, cancel: "error" }, // definitely want start event
                );
            }
        }

        try {
            await this.deltaManager.inbound.pause();

            const summaryRefSeqNum = this.deltaManager.lastSequenceNumber;
            const minimumSequenceNumber = this.deltaManager.minimumSequenceNumber;
            const message = `Summary @${summaryRefSeqNum}:${this.deltaManager.minimumSequenceNumber}`;

            // We should be here is we haven't processed be here. If we are of if the last message's sequence number
            // doesn't match the last processed sequence number, log an error.
            if (summaryRefSeqNum !== this.deltaManager.lastMessage?.sequenceNumber) {
                summaryNumberLogger.sendErrorEvent({
                    eventName: "LastSequenceMismatch",
                    error: message,
                });
            }

            this.summarizerNode.startSummary(summaryRefSeqNum, summaryNumberLogger);

            // Helper function to check whether we should still continue between each async step.
            const checkContinue = (): { continue: true; } | { continue: false; error: string; } => {
                // Do not check for loss of connectivity directly! Instead leave it up to
                // RunWhileConnectedCoordinator to control policy in a single place.
                // This will allow easier change of design if we chose to. For example, we may chose to allow
                // summarizer to reconnect in the future.
                // Also checking for cancellation is a must as summary process may be abandoned for other reasons,
                // like loss of connectivity for main (interactive) client.
                if (options.cancellationToken.cancelled) {
                    return { continue: false, error: "disconnected" };
                }
                // That said, we rely on submitSystemMessage() that today only works in connected state.
                // So if we fail here, it either means that RunWhileConnectedCoordinator does not work correctly,
                // OR that design changed and we need to remove this check and fix submitSystemMessage.
                assert(this.connected, 0x258 /* "connected" */);

                // Ensure that lastSequenceNumber has not changed after pausing.
                // We need the summary op's reference sequence number to match our summary sequence number,
                // otherwise we'll get the wrong sequence number stamped on the summary's .protocol attributes.
                if (this.deltaManager.lastSequenceNumber !== summaryRefSeqNum) {
                    return {
                        continue: false,
                        // eslint-disable-next-line max-len
                        error: `lastSequenceNumber changed before uploading to storage. ${this.deltaManager.lastSequenceNumber} !== ${summaryRefSeqNum}`,
                    };
                }
                return { continue: true };
            };

            let continueResult = checkContinue();
            if (!continueResult.continue) {
                return {
                    stage: "base",
                    referenceSequenceNumber: summaryRefSeqNum,
                    minimumSequenceNumber,
                    error: continueResult.error,
                };
            }

            const trace = Trace.start();
            let summarizeResult: IRootSummaryTreeWithStats;
            // If the GC state needs to be reset, we need to force a full tree summary and update the unreferenced
            // state of all the nodes.
            const forcedFullTree = this.garbageCollector.summaryStateNeedsReset;
            try {
                summarizeResult = await this.summarize({
                    fullTree: fullTree || forcedFullTree,
                    trackState: true,
                    summaryLogger: summaryNumberLogger,
                    runGC: this.garbageCollector.shouldRunGC,
                });
            } catch (error) {
                return {
                    stage: "base",
                    referenceSequenceNumber: summaryRefSeqNum,
                    minimumSequenceNumber,
                    error,
                };
            }
            const { summary: summaryTree, stats: partialStats } = summarizeResult;

            // Now that we have generated the summary, update the message at last summary to the last message processed.
            this.messageAtLastSummary = this.deltaManager.lastMessage;

            // Counting dataStores and handles
            // Because handles are unchanged dataStores in the current logic,
            // summarized dataStore count is total dataStore count minus handle count
            const dataStoreTree = this.disableIsolatedChannels ? summaryTree : summaryTree.tree[channelsTreeName];

            assert(dataStoreTree.type === SummaryType.Tree, 0x1fc /* "summary is not a tree" */);
            const handleCount = Object.values(dataStoreTree.tree).filter(
                (value) => value.type === SummaryType.Handle).length;
            const gcSummaryTreeStats = summaryTree.tree[gcTreeKey]
                ? calculateStats(summaryTree.tree[gcTreeKey])
                : undefined;

            const summaryStats: IGeneratedSummaryStats = {
                dataStoreCount: this.dataStores.size,
                summarizedDataStoreCount: this.dataStores.size - handleCount,
                gcStateUpdatedDataStoreCount: summarizeResult.gcStats?.updatedDataStoreCount,
                gcBlobNodeCount: gcSummaryTreeStats?.blobNodeCount,
                gcTotalBlobsSize: gcSummaryTreeStats?.totalBlobSize,
                opsSizesSinceLastSummary: this.opTracker.opsSizeAccumulator,
                nonSystemOpsSinceLastSummary: this.opTracker.nonSystemOpCount,
                summaryNumber,
                ...partialStats,
            };
            const generateSummaryData = {
                referenceSequenceNumber: summaryRefSeqNum,
                minimumSequenceNumber,
                summaryTree,
                summaryStats,
                generateDuration: trace.trace().duration,
                forcedFullTree,
            } as const;

            continueResult = checkContinue();
            if (!continueResult.continue) {
                return { stage: "generate", ...generateSummaryData, error: continueResult.error };
            }

            const lastAck = this.summaryCollection.latestAck;
            const summaryContext: ISummaryContext =
                lastAck === undefined
                ? {
                    proposalHandle: undefined,
                    ackHandle: this.context.getLoadedFromVersion()?.id,
                    referenceSequenceNumber: summaryRefSeqNum,
                }
                : {
                    proposalHandle: lastAck.summaryOp.contents.handle,
                    ackHandle: lastAck.summaryAck.contents.handle,
                    referenceSequenceNumber: summaryRefSeqNum,
                };

            let handle: string;
            try {
                handle = await this.storage.uploadSummaryWithContext(summarizeResult.summary, summaryContext);
            } catch (error) {
                return { stage: "generate", ...generateSummaryData, error };
            }

            const parent = summaryContext.ackHandle;
            const summaryMessage: ISummaryContent = {
                handle,
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                head: parent!,
                message,
                parents: parent ? [parent] : [],
            };
            const uploadData = {
                ...generateSummaryData,
                handle,
                uploadDuration: trace.trace().duration,
            } as const;

            continueResult = checkContinue();
            if (!continueResult.continue) {
                return { stage: "upload", ...uploadData, error: continueResult.error };
            }

            let clientSequenceNumber: number;
            try {
                clientSequenceNumber = this.submitSystemMessage(MessageType.Summarize, summaryMessage);
            } catch (error) {
                return { stage: "upload", ...uploadData, error };
            }

            const submitData = {
                stage: "submit",
                ...uploadData,
                clientSequenceNumber,
                submitOpDuration: trace.trace().duration,
            } as const;

            this.summarizerNode.completeSummary(handle);
            this.opTracker.reset();
            return submitData;
        } finally {
            // Cleanup wip summary in case of failure
            this.summarizerNode.clearSummary();
            // Restart the delta manager
            this.deltaManager.inbound.resume();
        }
    }

    private processRemoteChunkedMessage(message: ISequencedDocumentMessage) {
        if (message.type !== ContainerMessageType.ChunkedOp) {
            return message;
        }

        const clientId = message.clientId;
        const chunkedContent = message.contents as IChunkedOp;
        this.addChunk(clientId, chunkedContent);
        if (chunkedContent.chunkId === chunkedContent.totalChunks) {
            const newMessage = { ...message };
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const serializedContent = this.chunkMap.get(clientId)!.join("");
            newMessage.contents = JSON.parse(serializedContent);
            newMessage.type = chunkedContent.originalType;
            this.clearPartialChunks(clientId);
            return newMessage;
        }
        return message;
    }

    private addChunk(clientId: string, chunkedContent: IChunkedOp) {
        let map = this.chunkMap.get(clientId);
        if (map === undefined) {
            map = [];
            this.chunkMap.set(clientId, map);
        }
        assert(chunkedContent.chunkId === map.length + 1,
            0x131 /* "Mismatch between new chunkId and expected chunkMap" */); // 1-based indexing
        map.push(chunkedContent.contents);
    }

    private clearPartialChunks(clientId: string) {
        if (this.chunkMap.has(clientId)) {
            this.chunkMap.delete(clientId);
        }
    }

    private updateDocumentDirtyState(dirty: boolean) {
        if (this.dirtyContainer === dirty) {
            return;
        }

        this.dirtyContainer = dirty;
        if (this.emitDirtyDocumentEvent) {
            this.emit(dirty ? "dirty" : "saved");
            this.context.updateDirtyContainerState(dirty);
        }
    }

    public submitDataStoreOp(
        id: string,
        contents: any,
        localOpMetadata: unknown = undefined): void {
        const envelope: IEnvelope = {
            address: id,
            contents,
        };
        this.submit(ContainerMessageType.FluidDataStoreOp, envelope, localOpMetadata);
    }

    public submitDataStoreAliasOp(contents: any, localOpMetadata: unknown): void {
        const aliasMessage = contents as IDataStoreAliasMessage;
        if (!isDataStoreAliasMessage(aliasMessage)) {
            throw new UsageError("malformedDataStoreAliasMessage");
        }

        this.submit(ContainerMessageType.Alias, contents, localOpMetadata);
    }

    public async uploadBlob(blob: ArrayBufferLike): Promise<IFluidHandle<ArrayBufferLike>> {
        this.verifyNotClosed();
        return this.blobManager.createBlob(blob);
    }

    private submit(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown = undefined,
        opMetadata: Record<string, unknown> | undefined = undefined,
    ): void {
        this.verifyNotClosed();

        // There should be no ops in detached container state!
        assert(this.attachState !== AttachState.Detached, 0x132 /* "sending ops in detached container" */);

        let clientSequenceNumber: number = -1;
        let opMetadataInternal = opMetadata;

        if (this.canSendOps()) {
            const serializedContent = JSON.stringify(content);
            const maxOpSize = this.context.deltaManager.maxMessageSize;

            // If in TurnBased flush mode we will trigger a flush at the next turn break
            if (this.flushMode === FlushMode.TurnBased && !this.needsFlush) {
                opMetadataInternal = {
                    ...opMetadata,
                    batch: true,
                };
                this.needsFlush = true;

                // Use Promise.resolve().then() to queue a microtask to detect the end of the turn and force a flush.
                if (!this.flushTrigger) {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    Promise.resolve().then(() => {
                        this.flushTrigger = false;
                        this.flush();
                    });
                }
            }

            clientSequenceNumber = this.submitMaybeChunkedMessages(
                type,
                content,
                serializedContent,
                maxOpSize,
                this._flushMode === FlushMode.TurnBased,
                opMetadataInternal);
        }

        // Let the PendingStateManager know that a message was submitted.
        this.pendingStateManager.onSubmitMessage(
            type,
            clientSequenceNumber,
            this.deltaManager.lastSequenceNumber,
            content,
            localOpMetadata,
            opMetadataInternal,
        );
        if (this.isContainerMessageDirtyable(type, content)) {
            this.updateDocumentDirtyState(true);
        }
    }

    private submitMaybeChunkedMessages(
        type: ContainerMessageType,
        content: any,
        serializedContent: string,
        serverMaxOpSize: number,
        batch: boolean,
        opMetadataInternal: unknown = undefined,
    ): number {
        if (this._maxOpSizeInBytes >= 0) {
            // Chunking disabled
            if (!serializedContent || serializedContent.length <= this._maxOpSizeInBytes) {
                return this.submitRuntimeMessage(type, content, batch, opMetadataInternal);
            }

            // When chunking is disabled, we ignore the server max message size
            // and if the content length is larger than the client configured message size
            // instead of splitting the content, we will fail by explicitly close the container
            this.closeFn(new GenericError(
                "OpTooLarge",
                /* error */ undefined,
                {
                    length: {
                        value: serializedContent.length,
                        tag: TelemetryDataTag.PackageData,
                    },
                    limit: {
                        value: this._maxOpSizeInBytes,
                        tag: TelemetryDataTag.PackageData,
                    },
                }));
            return -1;
        }

        // Chunking enabled, fallback on the server's max message size
        // and split the content accordingly
        if (!serializedContent || serializedContent.length <= serverMaxOpSize) {
            return this.submitRuntimeMessage(type, content, batch, opMetadataInternal);
        }

        return this.submitChunkedMessage(type, serializedContent, serverMaxOpSize);
    }

    private submitChunkedMessage(type: ContainerMessageType, content: string, maxOpSize: number): number {
        const contentLength = content.length;
        const chunkN = Math.floor((contentLength - 1) / maxOpSize) + 1;
        let offset = 0;
        let clientSequenceNumber: number = 0;
        for (let i = 1; i <= chunkN; i = i + 1) {
            const chunkedOp: IChunkedOp = {
                chunkId: i,
                contents: content.substr(offset, maxOpSize),
                originalType: type,
                totalChunks: chunkN,
            };
            offset += maxOpSize;
            clientSequenceNumber = this.submitRuntimeMessage(
                ContainerMessageType.ChunkedOp,
                chunkedOp,
                false);
        }
        return clientSequenceNumber;
    }

    private submitSystemMessage(
        type: MessageType,
        contents: any) {
        this.verifyNotClosed();
        assert(this.connected, 0x133 /* "Container disconnected when trying to submit system message" */);

        // System message should not be sent in the middle of the batch.
        // That said, we can preserve existing behavior by not flushing existing buffer.
        // That might be not what caller hopes to get, but we can look deeper if telemetry tells us it's a problem.
        const middleOfBatch = this.flushMode === FlushMode.TurnBased && this.needsFlush;
        if (middleOfBatch) {
            this.mc.logger.sendErrorEvent({ eventName: "submitSystemMessageError", type });
        }

        return this.context.submitFn(
            type,
            contents,
            middleOfBatch);
    }

    private submitRuntimeMessage(
        type: ContainerMessageType,
        contents: any,
        batch: boolean,
        appData?: any,
    ) {
        this.verifyNotClosed();
        assert(this.connected, 0x259 /* "Container disconnected when trying to submit system message" */);
        const payload: ContainerRuntimeMessage = { type, contents };
        return this.context.submitFn(
            MessageType.Operation,
            payload,
            batch,
            appData);
    }

    /**
     * Throw an error if the runtime is closed.  Methods that are expected to potentially
     * be called after dispose due to asynchrony should not call this.
     */
    private verifyNotClosed() {
        if (this._disposed) {
            throw new Error("Runtime is closed");
        }
    }

    /**
     * Finds the right store and asks it to resubmit the message. This typically happens when we
     * reconnect and there are pending messages.
     * @param content - The content of the original message.
     * @param localOpMetadata - The local metadata associated with the original message.
     */
    private reSubmit(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown,
        opMetadata: Record<string, unknown> | undefined,
    ) {
        switch (type) {
            case ContainerMessageType.FluidDataStoreOp:
                // For Operations, call resubmitDataStoreOp which will find the right store
                // and trigger resubmission on it.
                this.dataStores.resubmitDataStoreOp(content, localOpMetadata);
                break;
            case ContainerMessageType.Attach:
            case ContainerMessageType.Alias:
                this.submit(type, content, localOpMetadata);
                break;
            case ContainerMessageType.ChunkedOp:
                throw new Error(`chunkedOp not expected here`);
            case ContainerMessageType.BlobAttach:
                this.submit(type, content, localOpMetadata, opMetadata);
                break;
            case ContainerMessageType.Rejoin:
                this.submit(type, content);
                break;
            default:
                unreachableCase(type, `Unknown ContainerMessageType: ${type}`);
        }
    }

    private rollback(
        type: ContainerMessageType,
        content: any,
        localOpMetadata: unknown,
    ) {
        switch (type) {
            case ContainerMessageType.FluidDataStoreOp:
                // For operations, call rollbackDataStoreOp which will find the right store
                // and trigger rollback on it.
                this.dataStores.rollbackDataStoreOp(content, localOpMetadata);
                break;
            default:
                throw new Error(`Can't rollback ${type}`);
        }
    }

    /** Implementation of ISummarizerInternalsProvider.refreshLatestSummaryAck */
    public async refreshLatestSummaryAck(
        proposalHandle: string | undefined,
        ackHandle: string,
        summaryRefSeq: number,
        summaryLogger: ITelemetryLogger,
    ) {
        const readAndParseBlob = async <T>(id: string) => readAndParse<T>(this.storage, id);
        const result = await this.summarizerNode.refreshLatestSummary(
            proposalHandle,
            summaryRefSeq,
            async () => this.fetchSnapshotFromStorage(ackHandle, summaryLogger, {
                eventName: "RefreshLatestSummaryGetSnapshot",
                ackHandle,
                summaryRefSeq,
                fetchLatest: false,
            }),
            readAndParseBlob,
            summaryLogger,
        );

        // Notify the garbage collector so it can update its latest summary state.
        await this.garbageCollector.latestSummaryStateRefreshed(result, readAndParseBlob);
    }

    /**
     * Fetches the latest snapshot from storage and uses it to refresh SummarizerNode's
     * internal state as it should be considered the latest summary ack.
     * @param summaryLogger - logger to use when fetching snapshot from storage
     * @returns downloaded snapshot's reference sequence number
     */
    private async refreshLatestSummaryAckFromServer(summaryLogger: ITelemetryLogger): Promise<number> {
        const snapshot = await this.fetchSnapshotFromStorage(null, summaryLogger, {
            eventName: "RefreshLatestSummaryGetSnapshot",
            fetchLatest: true,
        });

        const readAndParseBlob = async <T>(id: string) => readAndParse<T>(this.storage, id);
        const snapshotRefSeq = await seqFromTree(snapshot, readAndParseBlob);

        const result = await this.summarizerNode.refreshLatestSummary(
            undefined,
            snapshotRefSeq,
            async () => snapshot,
            readAndParseBlob,
            summaryLogger,
        );

        // Notify the garbage collector so it can update its latest summary state.
        await this.garbageCollector.latestSummaryStateRefreshed(result, readAndParseBlob);

        return snapshotRefSeq;
    }

    private async fetchSnapshotFromStorage(
        versionId: string | null, logger: ITelemetryLogger, event: ITelemetryGenericEvent) {
        return PerformanceEvent.timedExecAsync(
            logger, event, async (perfEvent: {
                end: (arg0: {
                    getVersionDuration?: number | undefined;
                    getSnapshotDuration?: number | undefined;
                }) => void; }) => {
                    const stats: { getVersionDuration?: number; getSnapshotDuration?: number; } = {};
                    const trace = Trace.start();

                    const versions = await this.storage.getVersions(versionId, 1);
                    assert(!!versions && !!versions[0], 0x137 /* "Failed to get version from storage" */);
                    stats.getVersionDuration = trace.trace().duration;

                    const maybeSnapshot = await this.storage.getSnapshotTree(versions[0]);
                    assert(!!maybeSnapshot, 0x138 /* "Failed to get snapshot from storage" */);
                    stats.getSnapshotDuration = trace.trace().duration;

                    perfEvent.end(stats);
                    return maybeSnapshot;
        });
    }

    public notifyAttaching(snapshot: ISnapshotTreeWithBlobContents) {
        if (this.mc.config.getBoolean("enableOfflineLoad") ?? this.runtimeOptions.enableOfflineLoad) {
            this.baseSnapshotBlobs = SerializedSnapshotStorage.serializeTreeWithBlobContents(snapshot);
        }
    }

    public async getSnapshotBlobs(): Promise<void> {
        if (!(this.mc.config.getBoolean("enableOfflineLoad") ?? this.runtimeOptions.enableOfflineLoad) ||
            this.attachState !== AttachState.Attached || this.context.pendingLocalState) {
            return;
        }
        assert(!!this.context.baseSnapshot, 0x2e5 /* "Must have a base snapshot" */);
        this.baseSnapshotBlobs = await SerializedSnapshotStorage.serializeTree(this.context.baseSnapshot, this.storage);
    }

    public getPendingLocalState(): IPendingRuntimeState {
        if (!(this.mc.config.getBoolean("enableOfflineLoad") ?? this.runtimeOptions.enableOfflineLoad)) {
            throw new UsageError("can't get state when offline load disabled");
        }

        const previousPendingState = this.context.pendingLocalState as IPendingRuntimeState | undefined;
        if (previousPendingState) {
            return {
                pending: this.pendingStateManager.getLocalState(),
                snapshotBlobs: previousPendingState.snapshotBlobs,
                baseSnapshot: previousPendingState.baseSnapshot,
                savedOps: this.savedOps,
            };
        }
        assert(!!this.context.baseSnapshot, 0x2e6 /* "Must have a base snapshot" */);
        assert(!!this.baseSnapshotBlobs, 0x2e7 /* "Must serialize base snapshot blobs before getting runtime state" */);
        return {
            pending: this.pendingStateManager.getLocalState(),
            snapshotBlobs: this.baseSnapshotBlobs,
            baseSnapshot: this.context.baseSnapshot,
            savedOps: this.savedOps,
        };
    }

    public readonly summarizeOnDemand: ISummarizer["summarizeOnDemand"] = (...args) => {
        if (this.clientDetails.type === summarizerClientType) {
            return this.summarizer.summarizeOnDemand(...args);
        } else if (this.summaryManager !== undefined) {
            return this.summaryManager.summarizeOnDemand(...args);
        } else {
            // If we're not the summarizer, and we don't have a summaryManager, we expect that
            // disableSummaries is turned on. We are throwing instead of returning a failure here,
            // because it is a misuse of the API rather than an expected failure.
            throw new UsageError(
                `Can't summarize, disableSummaries: ${this.summariesDisabled}`,
            );
        }
    };

    public readonly enqueueSummarize: ISummarizer["enqueueSummarize"] = (...args) => {
        if (this.clientDetails.type === summarizerClientType) {
            return this.summarizer.enqueueSummarize(...args);
        } else if (this.summaryManager !== undefined) {
            return this.summaryManager.enqueueSummarize(...args);
        } else {
            // If we're not the summarizer, and we don't have a summaryManager, we expect that
            // generateSummaries is turned off. We are throwing instead of returning a failure here,
            // because it is a misuse of the API rather than an expected failure.
            throw new UsageError(
                `Can't summarize, disableSummaries: ${this.summariesDisabled}`,
                );
        }
    };

    /**
     * * Forms a function that will request a Summarizer.
     * @param loaderRouter - the loader acting as an IFluidRouter
     * */
    private formRequestSummarizerFn(loaderRouter: IFluidRouter) {
        return async () => {
            const request: IRequest = {
                headers: {
                    [LoaderHeader.cache]: false,
                    [LoaderHeader.clientDetails]: {
                        capabilities: { interactive: false },
                        type: summarizerClientType,
                    },
                    [DriverHeader.summarizingClient]: true,
                    [LoaderHeader.reconnect]: false,
                },
                url: "/_summarizer",
            };

            const fluidObject = await requestFluidObject<FluidObject<ISummarizer>>(loaderRouter, request);
            const summarizer = fluidObject.ISummarizer;

            if (!summarizer) {
                throw new UsageError("Fluid object does not implement ISummarizer");
            }

            return summarizer;
        };
    }

    private async processSavedOps(state: IPendingRuntimeState) {
        for (const op of state.savedOps) {
            this.process(op, false);
            await this.pendingStateManager.applyStashedOpsAt(op.sequenceNumber);
        }
        // we may not have seen every sequence number (because of system ops) so apply everything once we
        // don't have any more saved ops
        await this.pendingStateManager.applyStashedOpsAt();
    }
}

/**
 * Wait for a specific sequence number. Promise should resolve when we reach that number,
 * or reject if closed.
 */
const waitForSeq = async (
    deltaManager: IDeltaManager<Pick<ISequencedDocumentMessage, "sequenceNumber">, unknown>,
    targetSeq: number,
): Promise<void> => new Promise<void>((resolve, reject) => {
    // TODO: remove cast to any when actual event is determined
    deltaManager.on("closed" as any, reject);

    const handleOp = (message: Pick<ISequencedDocumentMessage, "sequenceNumber">) => {
        if (message.sequenceNumber >= targetSeq) {
            resolve();
            deltaManager.off("op", handleOp);
        }
    };
    deltaManager.on("op", handleOp);
});

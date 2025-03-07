## API Report File for "@fluidframework/driver-utils"

> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).

```ts

import { DriverErrorType } from '@fluidframework/driver-definitions';
import { IAuthorizationError } from '@fluidframework/driver-definitions';
import { ICommittedProposal } from '@fluidframework/protocol-definitions';
import { ICreateBlobResponse } from '@fluidframework/protocol-definitions';
import { IDeltasFetchResult } from '@fluidframework/driver-definitions';
import { IDocumentAttributes } from '@fluidframework/protocol-definitions';
import { IDocumentMessage } from '@fluidframework/protocol-definitions';
import { IDocumentService } from '@fluidframework/driver-definitions';
import { IDocumentServiceFactory } from '@fluidframework/driver-definitions';
import { IDocumentStorageService } from '@fluidframework/driver-definitions';
import { IDocumentStorageServicePolicies } from '@fluidframework/driver-definitions';
import { IDriverErrorBase } from '@fluidframework/driver-definitions';
import { IFluidErrorBase } from '@fluidframework/telemetry-utils';
import { IFluidResolvedUrl } from '@fluidframework/driver-definitions';
import { IRequest } from '@fluidframework/core-interfaces';
import { IResolvedUrl } from '@fluidframework/driver-definitions';
import { ISequencedDocumentMessage } from '@fluidframework/protocol-definitions';
import { ISnapshotTree } from '@fluidframework/protocol-definitions';
import { IStream } from '@fluidframework/driver-definitions';
import { IStreamResult } from '@fluidframework/driver-definitions';
import { ISummaryContext } from '@fluidframework/driver-definitions';
import { ISummaryHandle } from '@fluidframework/protocol-definitions';
import { ISummaryTree } from '@fluidframework/protocol-definitions';
import { ITelemetryBaseLogger } from '@fluidframework/common-definitions';
import { ITelemetryErrorEvent } from '@fluidframework/common-definitions';
import { ITelemetryLogger } from '@fluidframework/common-definitions';
import { ITelemetryProperties } from '@fluidframework/common-definitions';
import { IThrottlingWarning } from '@fluidframework/driver-definitions';
import { ITree } from '@fluidframework/protocol-definitions';
import { ITreeEntry } from '@fluidframework/protocol-definitions';
import { IUrlResolver } from '@fluidframework/driver-definitions';
import { IVersion } from '@fluidframework/protocol-definitions';
import { LoaderCachingPolicy } from '@fluidframework/driver-definitions';
import { LoggingError } from '@fluidframework/telemetry-utils';
import { SummaryType } from '@fluidframework/protocol-definitions';

// @public (undocumented)
export class AuthorizationError extends LoggingError implements IAuthorizationError, IFluidErrorBase {
    constructor(message: string, claims: string | undefined, tenantId: string | undefined, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly canRetry = false;
    // (undocumented)
    readonly claims: string | undefined;
    // (undocumented)
    readonly errorType = DriverErrorType.authorizationError;
    // (undocumented)
    readonly tenantId: string | undefined;
}

// @public (undocumented)
export class BlobAggregationStorage extends SnapshotExtractor implements IDocumentStorageService {
    protected constructor(storage: IDocumentStorageService, logger: ITelemetryLogger, allowPacking: boolean, packingLevel: number, blobCutOffSize?: number | undefined);
    // (undocumented)
    createBlob(file: ArrayBufferLike): Promise<ICreateBlobResponse>;
    // (undocumented)
    downloadSummary(handle: ISummaryHandle): Promise<ISummaryTree>;
    // (undocumented)
    static readonly fullDataStoreSummaries = true;
    // (undocumented)
    getBlob(id: string, tree: ISnapshotTree): Promise<ArrayBufferLike>;
    // (undocumented)
    getSnapshotTree(version?: IVersion): Promise<ISnapshotTree | null>;
    // (undocumented)
    getVersions(versionId: string | null, count: number): Promise<IVersion[]>;
    // (undocumented)
    protected isRealStorageId(id: string): boolean;
    // (undocumented)
    protected loadedFromSummary: boolean;
    // (undocumented)
    get policies(): IDocumentStorageServicePolicies | undefined;
    // (undocumented)
    readBlob(id: string): Promise<ArrayBufferLike>;
    // (undocumented)
    get repositoryUrl(): string;
    // (undocumented)
    setBlob(id: string, tree: ISnapshotTree, content: string): void;
    // (undocumented)
    static unpackSnapshot(snapshot: ISnapshotTree): Promise<void>;
    // (undocumented)
    unpackSnapshot(snapshot: ISnapshotTree): Promise<void>;
    // (undocumented)
    uploadSummaryWithContext(summary: ISummaryTree, context: ISummaryContext): Promise<string>;
    // (undocumented)
    protected virtualBlobs: Map<string, ArrayBufferLike>;
    // (undocumented)
    static wrap(storage: IDocumentStorageService, logger: ITelemetryLogger, allowPacking?: boolean, packingLevel?: number): BlobAggregationStorage;
}

// @public
export class BlobCacheStorageService extends DocumentStorageServiceProxy {
    constructor(internalStorageService: IDocumentStorageService, blobs: Map<string, ArrayBufferLike>);
    // (undocumented)
    get policies(): IDocumentStorageServicePolicies | undefined;
    // (undocumented)
    readBlob(id: string): Promise<ArrayBufferLike>;
}

// @public
export function buildSnapshotTree(entries: ITreeEntry[], blobMap: Map<string, ArrayBufferLike>): ISnapshotTree;

// @public
export const canRetryOnError: (error: any) => boolean;

// @public
export function combineAppAndProtocolSummary(appSummary: ISummaryTree, protocolSummary: ISummaryTree): ISummaryTree;

// @public
export function configurableUrlResolver(resolversList: IUrlResolver[], request: IRequest): Promise<IResolvedUrl | undefined>;

// @public
export function convertSnapshotAndBlobsToSummaryTree(snapshot: ISnapshotTree, blobs: Map<string, ArrayBuffer>): ISummaryTree;

// @public
export function convertSummaryTreeToSnapshotITree(summaryTree: ISummaryTree): ITree;

// @public (undocumented)
export function createGenericNetworkError(message: string, retryInfo: {
    canRetry: boolean;
    retryAfterMs?: number;
}, props: DriverErrorTelemetryProps): ThrottlingError | GenericNetworkError;

// @public (undocumented)
export const createWriteError: (message: string, props: DriverErrorTelemetryProps) => NonRetryableError<DriverErrorType.writeError>;

// @public (undocumented)
export class DeltaStreamConnectionForbiddenError extends LoggingError implements IFluidErrorBase {
    constructor(message: string, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly canRetry = false;
    // (undocumented)
    static readonly errorType: string;
    // (undocumented)
    readonly errorType: string;
}

// @public (undocumented)
export class DocumentStorageServiceProxy implements IDocumentStorageService {
    constructor(internalStorageService: IDocumentStorageService);
    // (undocumented)
    createBlob(file: ArrayBufferLike): Promise<ICreateBlobResponse>;
    // (undocumented)
    downloadSummary(handle: ISummaryHandle): Promise<ISummaryTree>;
    // (undocumented)
    getSnapshotTree(version?: IVersion, scenarioName?: string): Promise<ISnapshotTree | null>;
    // (undocumented)
    getVersions(versionId: string | null, count: number, scenarioName?: string): Promise<IVersion[]>;
    // (undocumented)
    protected readonly internalStorageService: IDocumentStorageService;
    set policies(policies: IDocumentStorageServicePolicies | undefined);
    // (undocumented)
    get policies(): IDocumentStorageServicePolicies | undefined;
    // (undocumented)
    readBlob(blobId: string): Promise<ArrayBufferLike>;
    // (undocumented)
    get repositoryUrl(): string;
    // (undocumented)
    uploadSummaryWithContext(summary: ISummaryTree, context: ISummaryContext): Promise<string>;
}

// @public
export type DriverErrorTelemetryProps = ITelemetryProperties & {
    driverVersion: string | undefined;
};

// @public (undocumented)
export const emptyMessageStream: IStream<ISequencedDocumentMessage[]>;

// @public (undocumented)
export function ensureFluidResolvedUrl(resolved: IResolvedUrl | undefined): asserts resolved is IFluidResolvedUrl;

// @public
export class GenericNetworkError extends LoggingError implements IDriverErrorBase, IFluidErrorBase {
    constructor(message: string, canRetry: boolean, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly canRetry: boolean;
    // (undocumented)
    readonly errorType = DriverErrorType.genericNetworkError;
}

// @public
export function getDocAttributesFromProtocolSummary(protocolSummary: ISummaryTree): IDocumentAttributes;

// @public
export function getQuorumValuesFromProtocolSummary(protocolSummary: ISummaryTree): [string, ICommittedProposal][];

// @public
export const getRetryDelayFromError: (error: any) => number | undefined;

// @public
export const getRetryDelaySecondsFromError: (error: any) => number | undefined;

// @public
export interface IAnyDriverError extends Omit<IDriverErrorBase, "errorType"> {
    // (undocumented)
    readonly errorType: string;
}

// @public
export class InsecureUrlResolver implements IUrlResolver {
    constructor(hostUrl: string, ordererUrl: string, storageUrl: string, tenantId: string, bearer: string, isForNodeTest?: boolean);
    // (undocumented)
    createCreateNewRequest(fileName?: string): IRequest;
    // (undocumented)
    getAbsoluteUrl(resolvedUrl: IResolvedUrl, relativeUrl: string): Promise<string>;
    // (undocumented)
    resolve(request: IRequest): Promise<IResolvedUrl | undefined>;
}

// @public
export interface IProgress {
    cancel?: AbortSignal;
    onRetry?(delayInMs: number, error: any): void;
}

// @public (undocumented)
export function isClientMessage(message: ISequencedDocumentMessage | IDocumentMessage): boolean;

// @public (undocumented)
export const isFluidResolvedUrl: (resolved: IResolvedUrl | undefined) => resolved is IFluidResolvedUrl;

// @public (undocumented)
export function isOnline(): OnlineStatus;

// @public (undocumented)
export function isRuntimeMessage(message: ISequencedDocumentMessage | IDocumentMessage): boolean;

// @public
export interface ISummaryTreeAssemblerProps {
    unreferenced?: true;
}

// @public (undocumented)
export function logNetworkFailure(logger: ITelemetryLogger, event: ITelemetryErrorEvent, error?: any): void;

// @public (undocumented)
export class MultiDocumentServiceFactory implements IDocumentServiceFactory {
    constructor(documentServiceFactories: IDocumentServiceFactory[]);
    // (undocumented)
    static create(documentServiceFactory: IDocumentServiceFactory | IDocumentServiceFactory[]): IDocumentServiceFactory;
    // (undocumented)
    createContainer(createNewSummary: ISummaryTree, createNewResolvedUrl: IResolvedUrl, logger?: ITelemetryBaseLogger, clientIsSummarizer?: boolean): Promise<IDocumentService>;
    // (undocumented)
    createDocumentService(resolvedUrl: IResolvedUrl, logger?: ITelemetryBaseLogger, clientIsSummarizer?: boolean): Promise<IDocumentService>;
    // (undocumented)
    readonly protocolName = "none:";
}

// @public (undocumented)
export class MultiUrlResolver implements IUrlResolver {
    // (undocumented)
    static create(urlResolver: IUrlResolver | IUrlResolver[]): IUrlResolver;
    // (undocumented)
    getAbsoluteUrl(resolvedUrl: IResolvedUrl, relativeUrl: string): Promise<string>;
    // (undocumented)
    resolve(request: IRequest): Promise<IResolvedUrl | undefined>;
}

// @public (undocumented)
export class NetworkErrorBasic<T extends string> extends LoggingError implements IFluidErrorBase {
    constructor(message: string, errorType: T, canRetry: boolean, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly canRetry: boolean;
    // (undocumented)
    readonly errorType: T;
}

// @public (undocumented)
export class NonRetryableError<T extends string> extends NetworkErrorBasic<T> {
    constructor(message: string, errorType: T, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly errorType: T;
}

// @public (undocumented)
export enum OnlineStatus {
    // (undocumented)
    Offline = 0,
    // (undocumented)
    Online = 1,
    // (undocumented)
    Unknown = 2
}

// @public
export class ParallelRequests<T> {
    constructor(from: number, to: number | undefined, payloadSize: number, logger: ITelemetryLogger, requestCallback: (request: number, from: number, to: number, strongTo: boolean, props: ITelemetryProperties) => Promise<{
        partial: boolean;
        cancel: boolean;
        payload: T[];
    }>, responseCallback: (payload: T[]) => void);
    // (undocumented)
    cancel(): void;
    // (undocumented)
    get canceled(): boolean;
    // (undocumented)
    run(concurrency: number): Promise<void>;
}

// @public (undocumented)
export class PrefetchDocumentStorageService extends DocumentStorageServiceProxy {
    // (undocumented)
    getSnapshotTree(version?: IVersion): Promise<ISnapshotTree | null>;
    // (undocumented)
    get policies(): {
        caching: LoaderCachingPolicy;
        minBlobSize?: number | undefined;
        maximumCacheDurationMs?: number | undefined;
    } | undefined;
    // (undocumented)
    readBlob(blobId: string): Promise<ArrayBufferLike>;
    // (undocumented)
    stopPrefetch(): void;
}

// @public
export class Queue<T> implements IStream<T> {
    // (undocumented)
    protected pushCore(value: Promise<IStreamResult<T>>): void;
    // (undocumented)
    pushDone(): void;
    // (undocumented)
    pushError(error: any): void;
    // (undocumented)
    pushValue(value: T): void;
    // (undocumented)
    read(): Promise<IStreamResult<T>>;
}

// @public (undocumented)
export class RateLimiter {
    constructor(maxRequests: number);
    // (undocumented)
    protected acquire(): Promise<void>;
    // (undocumented)
    protected readonly release: () => void;
    // (undocumented)
    schedule<T>(work: () => Promise<T>): Promise<T>;
    // (undocumented)
    get waitQueueLength(): number;
}

// @public
export function readAndParse<T>(storage: Pick<IDocumentStorageService, "readBlob">, id: string): Promise<T>;

// @public (undocumented)
export function requestOps(get: (from: number, to: number, telemetryProps: ITelemetryProperties) => Promise<IDeltasFetchResult>, concurrency: number, fromTotal: number, toTotal: number | undefined, payloadSize: number, logger: ITelemetryLogger, signal?: AbortSignal, fetchReason?: string): IStream<ISequencedDocumentMessage[]>;

// @public (undocumented)
export class RetryableError<T extends string> extends NetworkErrorBasic<T> {
    constructor(message: string, errorType: T, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly errorType: T;
}

// @public (undocumented)
export function runWithRetry<T>(api: (cancel?: AbortSignal) => Promise<T>, fetchCallName: string, logger: ITelemetryLogger, progress: IProgress): Promise<T>;

// @public (undocumented)
export abstract class SnapshotExtractor {
    // (undocumented)
    protected readonly aggregatedBlobName = "__big";
    // (undocumented)
    abstract getBlob(id: string, tree: ISnapshotTree): Promise<ArrayBufferLike>;
    // (undocumented)
    protected getNextVirtualId(): string;
    // (undocumented)
    abstract setBlob(id: string, tree: ISnapshotTree, content: string): any;
    // (undocumented)
    unpackSnapshotCore(snapshot: ISnapshotTree, level?: number): Promise<void>;
    // (undocumented)
    protected virtualIdCounter: number;
    // (undocumented)
    protected readonly virtualIdPrefix = "__";
}

// @public (undocumented)
export function streamFromMessages(messagesArg: Promise<ISequencedDocumentMessage[]>): IStream<ISequencedDocumentMessage[]>;

// @public (undocumented)
export function streamObserver<T>(stream: IStream<T>, handler: (value: IStreamResult<T>) => void): IStream<T>;

// @public
export class SummaryTreeAssembler {
    constructor(props?: ISummaryTreeAssemblerProps | undefined);
    addAttachment(id: string): void;
    addBlob(key: string, content: string | Uint8Array): void;
    addHandle(key: string, handleType: SummaryType.Tree | SummaryType.Blob | SummaryType.Attachment, handle: string): void;
    addTree(key: string, summary: ISummaryTree): void;
    get summary(): ISummaryTree;
}

// @public
export class ThrottlingError extends LoggingError implements IThrottlingWarning, IFluidErrorBase {
    constructor(message: string, retryAfterSeconds: number, props: DriverErrorTelemetryProps);
    // (undocumented)
    readonly canRetry = true;
    // (undocumented)
    readonly errorType = DriverErrorType.throttlingError;
    // (undocumented)
    readonly retryAfterSeconds: number;
}

// @public
export function waitForConnectedState(minDelay: number): Promise<void>;

// (No @packageDocumentation comment for this package)

```

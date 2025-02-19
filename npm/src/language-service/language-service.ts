// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as wasm from "../../lib/web/qsc_wasm.js";
import type {
  ICompletionList,
  IHover,
  ILocation,
  ISignatureHelp,
  INotebookMetadata,
  IWorkspaceConfiguration,
  IWorkspaceEdit,
  ITextEdit,
  ISpan,
  LanguageService,
} from "../../lib/node/qsc_wasm.cjs";
import { log } from "../log.js";
import {
  VSDiagnostic,
  mapDiagnostics,
  mapUtf16UnitsToUtf8Units,
  mapUtf8UnitsToUtf16Units,
} from "../vsdiagnostic.js";
import { IServiceEventTarget, IServiceProxy } from "../worker-proxy.js";
type QscWasm = typeof import("../../lib/node/qsc_wasm.cjs");

// Only one event type for now
export type LanguageServiceEvent = {
  type: "diagnostics";
  detail: {
    uri: string;
    version: number;
    diagnostics: VSDiagnostic[];
  };
};

// These need to be async/promise results for when communicating across a WebWorker, however
// for running the compiler in the same thread the result will be synchronous (a resolved promise).
export interface ILanguageService {
  updateConfiguration(config: IWorkspaceConfiguration): Promise<void>;
  updateDocument(uri: string, version: number, code: string): Promise<void>;
  updateNotebookDocument(
    notebookUri: string,
    version: number,
    metadata: INotebookMetadata,
    cells: {
      uri: string;
      version: number;
      code: string;
    }[],
  ): Promise<void>;
  closeDocument(uri: string): Promise<void>;
  closeNotebookDocument(notebookUri: string): Promise<void>;
  getCompletions(documentUri: string, offset: number): Promise<ICompletionList>;
  getHover(documentUri: string, offset: number): Promise<IHover | undefined>;
  getDefinition(
    documentUri: string,
    offset: number,
  ): Promise<ILocation | undefined>;
  getReferences(
    documentUri: string,
    offset: number,
    includeDeclaration: boolean,
  ): Promise<ILocation[]>;
  getSignatureHelp(
    documentUri: string,
    offset: number,
  ): Promise<ISignatureHelp | undefined>;
  getRename(
    documentUri: string,
    offset: number,
    newName: string,
  ): Promise<IWorkspaceEdit | undefined>;
  prepareRename(
    documentUri: string,
    offset: number,
  ): Promise<ITextEdit | undefined>;

  dispose(): Promise<void>;

  addEventListener<T extends LanguageServiceEvent["type"]>(
    type: T,
    listener: (event: Extract<LanguageServiceEvent, { type: T }>) => void,
  ): void;

  removeEventListener<T extends LanguageServiceEvent["type"]>(
    type: T,
    listener: (event: Extract<LanguageServiceEvent, { type: T }>) => void,
  ): void;
}

export const qsharpLibraryUriScheme = "qsharp-library-source";

export type ILanguageServiceWorker = ILanguageService & IServiceProxy;

export class QSharpLanguageService implements ILanguageService {
  private languageService: LanguageService;
  private eventHandler =
    new EventTarget() as IServiceEventTarget<LanguageServiceEvent>;

  // We need to keep a copy of the code for mapping diagnostics to utf16 offsets
  private code: { [uri: string]: string | undefined } = {};

  private readFile: (uri: string) => Promise<string | null>;

  private backgroundWork: Promise<void>;

  constructor(
    wasm: QscWasm,
    readFile: (uri: string) => Promise<string | null> = () =>
      Promise.resolve(null),
    listDir: (uri: string) => Promise<[string, number][]> = () =>
      Promise.resolve([]),
    getManifest: (uri: string) => Promise<{
      manifestDirectory: string;
    } | null> = () => Promise.resolve(null),
  ) {
    log.info("Constructing a QSharpLanguageService instance");
    this.languageService = new wasm.LanguageService();

    this.backgroundWork = this.languageService.start_background_work(
      this.onDiagnostics.bind(this),
      readFile,
      listDir,
      getManifest,
    );

    this.readFile = readFile;
  }

  async loadFile(uri: string): Promise<string | null> {
    const result = this.code[uri];
    if (result === undefined || result === null) {
      return await this.readFile(uri);
    }
    if (result === null || result === undefined) {
      log.error(
        "File",
        uri,
        "wasn't in document map when we expected it to be",
      );
      return null;
    }
    return result;
  }

  async updateConfiguration(config: IWorkspaceConfiguration): Promise<void> {
    this.languageService.update_configuration(config);
  }

  async updateDocument(
    documentUri: string,
    version: number,
    code: string,
  ): Promise<void> {
    this.code[documentUri] = code;
    this.languageService.update_document(documentUri, version, code);
  }

  async updateNotebookDocument(
    notebookUri: string,
    version: number,
    metadata: INotebookMetadata,
    cells: { uri: string; version: number; code: string }[],
  ): Promise<void> {
    // Note: If a cell was deleted, its uri & contents will remain in the map.
    // This is harmless and it keeps the code simpler to just leave it this way
    // instead of trying to maintain a perfect map.
    for (const cell of cells) {
      this.code[cell.uri] = cell.code;
    }
    this.languageService.update_notebook_document(notebookUri, metadata, cells);
  }

  async closeDocument(documentUri: string): Promise<void> {
    delete this.code[documentUri];
    this.languageService.close_document(documentUri);
  }

  async closeNotebookDocument(documentUri: string): Promise<void> {
    this.languageService.close_notebook_document(documentUri);
  }

  async getCompletions(
    documentUri: string,
    offset: number,
  ): Promise<ICompletionList> {
    const code = await this.loadFile(documentUri);

    if (code === null) {
      log.error(
        `getCompletions: expected ${documentUri} to be in the document map`,
      );
      return { items: [] };
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], code)[offset];
    const result = this.languageService.get_completions(
      documentUri,
      convertedOffset,
    );
    result.items.forEach(
      (item) =>
        item.additionalTextEdits?.forEach((edit) => {
          updateSpanFromUtf8ToUtf16(edit.range, code);
        }),
    );
    return result;
  }

  async getHover(
    documentUri: string,
    offset: number,
  ): Promise<IHover | undefined> {
    const code = await this.loadFile(documentUri);

    if (code === null) {
      log.error(`getHover: expected ${documentUri} to be in the document map`);
      return undefined;
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], code)[offset];
    const result = this.languageService.get_hover(documentUri, convertedOffset);
    if (result) {
      updateSpanFromUtf8ToUtf16(result.span, code);
    }
    return result;
  }

  async getDefinition(
    documentUri: string,
    offset: number,
  ): Promise<ILocation | undefined> {
    const sourceCode = await this.loadFile(documentUri);
    if (sourceCode === undefined || sourceCode === null) {
      log.error(
        `getDefinition: expected ${documentUri} to be in the document map`,
      );
      return undefined;
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], sourceCode)[
      offset
    ];
    const result = this.languageService.get_definition(
      documentUri,
      convertedOffset,
    );
    if (result) {
      let targetCode = (await this.loadFile(result.source)) || null;
      if (targetCode === null) {
        // Inspect the URL protocol (equivalent to the URI scheme + ":").
        // If the scheme is our library scheme, we need to call the wasm to
        // provide the library file's contents to do the utf8->utf16 mapping.
        const url = new URL(result.source);
        if (url.protocol === qsharpLibraryUriScheme + ":") {
          targetCode = wasm.get_library_source_content(url.pathname) || null;
          if (targetCode === undefined) {
            log.error(`getDefinition: expected ${url} to be in the library`);
            return undefined;
          }
        }
      }
      if (targetCode) {
        updateSpanFromUtf8ToUtf16(result.span, targetCode);
      } else {
        // https://github.com/microsoft/qsharp/issues/851
        log.error(
          `cannot do utf8->utf16 mapping for ${result.source} since contents are not available`,
        );
      }
    }
    return result;
  }

  async getReferences(
    documentUri: string,
    offset: number,
    includeDeclaration: boolean,
  ): Promise<ILocation[]> {
    const sourceCode = await this.loadFile(documentUri);
    if (sourceCode === undefined || sourceCode === null) {
      log.error(
        `getReferences: expected ${documentUri} to be in the document map`,
      );
      return [];
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], sourceCode)[
      offset
    ];
    const results = this.languageService.get_references(
      documentUri,
      convertedOffset,
      includeDeclaration,
    );
    if (results && results.length > 0) {
      const references: ILocation[] = [];
      for (const result of results) {
        let resultCode = await this.loadFile(result.source);

        // Inspect the URL protocol (equivalent to the URI scheme + ":").
        // If the scheme is our library scheme, we need to call the wasm to
        // provide the library file's contents to do the utf8->utf16 mapping.
        const url = new URL(result.source);
        if (url.protocol === qsharpLibraryUriScheme + ":") {
          resultCode = wasm.get_library_source_content(url.pathname) || null;
          if (resultCode === undefined) {
            log.error(`getReferences: expected ${url} to be in the library`);
          }
        }

        if (resultCode) {
          updateSpanFromUtf8ToUtf16(result.span, resultCode);
          references.push(result);
        } else {
          // https://github.com/microsoft/qsharp/issues/851
          log.error(
            `cannot do utf8->utf16 mapping for ${result.source} since contents are not available`,
          );
        }
      }
      return references;
    } else {
      return [];
    }
  }

  async getSignatureHelp(
    documentUri: string,
    offset: number,
  ): Promise<ISignatureHelp | undefined> {
    const code = await this.loadFile(documentUri);

    if (code === null) {
      log.error(`expected ${documentUri} to be in the document map`);
      return undefined;
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], code)[offset];
    const result = this.languageService.get_signature_help(
      documentUri,
      convertedOffset,
    );
    if (result) {
      result.signatures = result.signatures.map((sig) => {
        sig.parameters = sig.parameters.map((param) => {
          updateSpanFromUtf8ToUtf16(param.label, sig.label);
          return param;
        });
        return sig;
      });
    }
    return result;
  }

  async getRename(
    documentUri: string,
    offset: number,
    newName: string,
  ): Promise<IWorkspaceEdit | undefined> {
    const code = await this.loadFile(documentUri);

    if (code === null) {
      log.error(`expected ${documentUri} to be in the document map`);
      return undefined;
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], code)[offset];
    const result = this.languageService.get_rename(
      documentUri,
      convertedOffset,
      newName,
    );

    const mappedChanges: [string, ITextEdit[]][] = [];
    for (const [uri, edits] of result.changes) {
      const code = await this.loadFile(uri);
      if (code) {
        const mappedEdits = edits.map((edit) => {
          updateSpanFromUtf8ToUtf16(edit.range, code);
          return edit;
        });
        mappedChanges.push([uri, mappedEdits]);
      }
    }
    result.changes = mappedChanges;
    return result;
  }

  async prepareRename(
    documentUri: string,
    offset: number,
  ): Promise<ITextEdit | undefined> {
    const code = await this.loadFile(documentUri);

    if (code === null) {
      log.error(`expected ${documentUri} to be in the document map`);
      return undefined;
    }
    const convertedOffset = mapUtf16UnitsToUtf8Units([offset], code)[offset];
    const result = this.languageService.prepare_rename(
      documentUri,
      convertedOffset,
    );
    if (result) {
      updateSpanFromUtf8ToUtf16(result.range, code);
    }
    return result;
  }

  async dispose() {
    this.languageService.stop_background_work();
    await this.backgroundWork;
    this.languageService.free();
  }

  addEventListener<T extends LanguageServiceEvent["type"]>(
    type: T,
    listener: (event: Extract<LanguageServiceEvent, { type: T }>) => void,
  ) {
    this.eventHandler.addEventListener(type, listener);
  }

  removeEventListener<T extends LanguageServiceEvent["type"]>(
    type: T,
    listener: (event: Extract<LanguageServiceEvent, { type: T }>) => void,
  ) {
    this.eventHandler.removeEventListener(type, listener);
  }

  async onDiagnostics(
    uri: string,
    version: number | undefined,
    diagnostics: VSDiagnostic[],
  ) {
    try {
      const code = await this.loadFile(uri);
      const empty = diagnostics.length === 0;
      if (code === null && !empty) {
        // We need the contents of the document to convert error offsets to utf16.
        // But the contents aren't available after a document is closed.

        // It is possible to get diagnostics events for a document after it's been closed,
        // since document events are handled asynchronously by the language service.
        // We just drop those diagnostics, assuming that eventually we will receive further
        // events that will bring the diagnostics up to date.

        // However, if we receive an *empty* array of diagnostics for a document, we don't want
        // to drop that update. It's necessary for the diagnostics to get cleared for a document
        // that has been closed.
        log.warn(
          `onDiagnostics: received diagnostics for ${uri} which is not in the document map`,
        );
        return;
      }
      const event = new Event("diagnostics") as LanguageServiceEvent & Event;
      event.detail = {
        uri,
        version: version ?? 0,
        diagnostics: empty ? [] : mapDiagnostics(diagnostics, code as string),
      };
      this.eventHandler.dispatchEvent(event);
    } catch (e) {
      log.error("Error in onDiagnostics", e);
    }
  }
}

function updateSpanFromUtf8ToUtf16(span: ISpan, code: string) {
  const mappedSpan = mapUtf8UnitsToUtf16Units([span.start, span.end], code);
  span.start = mappedSpan[span.start];
  span.end = mappedSpan[span.end];
}

// TODO: Should we look first in the `documents` document manager before calling
//  readFile and creating a TextDocument? It’s possible that it will be there
//  already if the user has multiple files open in the editor.
// TODO: Add settings to ignore certain file patterns.
// TODO: Add settings to resolve bare module specifiers. Or… better yet, pass
//  an import map (-like?) path in?
// TODO: Clean up all the files from the original clone — including swapping out
//  tabs for spaces in some of the files, etc.
// TODO: Create at least one minimal smoke test?
// TODO: Update README.md.
// TODO: Update CHANGELOG.md.
// TODO: Is it possible to use native ESM imports here?
//  https://jan.miksovsky.com/posts/2025/03-17-vs-code-extension.html
// TODO: What are our potential vectors for performance bottlenecks or memory
//  leaks — anything to be concerned about?
// TODO: Look into semantic token providers — “provideDocumentSemanticTokens”,
//  “provideDocumentSemanticTokensEdits”, and “onDidChangeSemanticTokens”. Might
//  be a potential, future optimization.
const vscodeLanguageserver = require('vscode-languageserver/node');
const vscodeLanguageserverTextdocument = require('vscode-languageserver-textdocument');
const vscodeUri = require('vscode-uri');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeUrl = require('node:url');

const {
  createConnection,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} = vscodeLanguageserver;

const {
  TextDocument,
} = vscodeLanguageserverTextdocument;

/**
 * Simple LRU cache for our documents to ensure we have a hard upper limit on
 * memory usage. The capacity here can be quite high — the goal is not to really
 * limit the documents which are in use. It’s more to ensure that we have some
 * upper-bound in place.
 *
 * Each document has the following structure:
 *  - settings:  {}
 *  - analysis: {
 *    - filePath
 *    - imports:   [{ uri, filePath }]
 *    - elements:  { [tagName]: { constructor: { name: { start, end, name }, properties: [{ … }] } } }
 *    - templates: [{ start, end, tokens: [{ type, start, end, substring }] }]
 *  }
 */
class DocumentCache {
  static #capacity = 10_000;
  static #map = new Map();

  // Gets (and potentially creates) item.
  static get(key) {
    if (DocumentCache.#map.has(key)) {
      const value = DocumentCache.#map.get(key);
      DocumentCache.#map.delete(key);
      DocumentCache.#map.set(key, value);
      return value;
    } else {
      const value = {};
      DocumentCache.set(key, value);
      return value;
    }
  }

  // Sets item (and potentially deletes oldest item).
  static set(key, value) {
    if (DocumentCache.#map.has(key)) {
      DocumentCache.#map.delete(key);
      DocumentCache.#map.set(key, value);
    } else {
      if (DocumentCache.#map.size > DocumentCache.#capacity) {
        const oldestKey = DocumentCache.#map.keys().next().value;
        DocumentCache.#map.delete(oldestKey);
      }
      DocumentCache.#map.set(key, value);
    }
  }

  // Clear entire cache.
  static clear() {
    DocumentCache.#map.clear();
  }
}

class Server {

  // Mapping of setTimeout ids to callbacks to reduce parsing / validation load.
  //  We want the delay to _feel fast_, but not actually cause us to re-parse
  //  on every keystroke (and definitely not on every key-repeat). Parsing a
  //  file _should_ take only a few milliseconds for a small file.
  static #delay = 150;
  static #requests = {};

  // If we load a file that is more than 300k characters long… just skip it.
  static #maxCharacters = 300_000;

  // XParser for html templates. We cannot statically import this yet. See
  //  related “import()” usage below — just a compatibility issue.
  static #XParserPromise = null;

  // Manages connection to our client.
  static #connection = createConnection(ProposedFeatures.all);

  // Text document manager.
  static #documents = new TextDocuments(TextDocument);

  // All the state we internally manage.
  static #documentCache = DocumentCache;
  static #flags = {
    hasConfigurationCapability: false,
    hasWorkspaceFolderCapability: false,
    hasDiagnosticRelatedInformationCapability: false,
  };
  static #defaultSettings = { maxNumberOfProblems: 100 };
  static #globalSettings = { ...Server.#defaultSettings };

  //////////////////////////////////////////////////////////////////////////////
  // Document Analysis /////////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  // Overcomes import compatibility issues by using “import()”.
  static async #loadXParser() {
    if (!Server.#XParserPromise) {
      Server.#XParserPromise = import('@netflix/x-element/x-parser.js').then(module => module.XParser);
    }
    return Server.#XParserPromise;
  }

  // Helper to improve async/await code for reading a text file.
  static async #readFile(filePath) {
    return new Promise((resolve, reject) => {
      const callback = (error, content) => error ? reject(error) : resolve(content);
      nodeFs.readFile(filePath, 'utf8', callback);
    });
  }

  // Helper to see if the first position is before the second in a document.
  static #isBefore(position1, position2) {
    return (
      position1.line < position2.line ||
      (
        position1.line === position2.line &&
        position1.character < position2.character
      )
    );
  }

  // Helper to see if the first position is after the second in a document.
  static #isAfter(position1, position2) {
    return (
      position1.line > position2.line ||
      (
        position1.line === position2.line &&
        position1.character > position2.character
      )
    );
  }

  // Helper to add line / character information to anchor for file link.
  static #createFileLink(uri, start) {
    const filePath = nodeUrl.fileURLToPath(uri);
    return `${filePath}#L${start.line + 1},${start.character + 1}`;
  }

  // Main document analysis logic.
  static async #parseDocument(document, options) {
    Server.#connection.console.log(`  parsing ${nodeUrl.fileURLToPath(document.uri)}`);

    try {
      const text = document.getText();

      // Don’t even bother analyzing a file if it’s over a certain size.
      if (text.length > Server.#maxCharacters) {
        return;
      }

      options ??= { parseImports: false };
      const XParser = await Server.#loadXParser();
      const uri = document.uri;
      const filePath = nodeUrl.fileURLToPath(uri);
      const ast = parser.parse(text, { sourceType: 'module' });
      // TODO: Could walk an ast for this information if we wanted instead…
      const constructorNameToTagName = {};
      const pattern = /customElements\.define\('(?<tagName>[a-z0-9-]+)', (?<constructorName>[A-Za-z0-9]+)\)/g;
      for (const match of text.matchAll(pattern)) {
        constructorNameToTagName[match.groups.constructorName] = match.groups.tagName;
      }
      const imports = [];
      const elements = {};
      const templates = [];
      traverse.default(ast, {
        TaggedTemplateExpression: path => {
          if (
            path?.node?.tag?.name === 'html' &&
            path?.node?.quasi?.quasis?.length > 0
          ) {
            const templateStart = document.positionAt(path.node.quasi.start);
            const templateEnd = document.positionAt(path.node.quasi.end);
            const quasis = path.node.quasi.quasis;
            const strings = quasis.map(node => node.value.cooked);
            strings.raw = quasis.map(node => node.value.raw);
            Object.freeze(strings.raw);
            Object.freeze(strings);
            const tokens = [];
            const onToken = (type, index, relativeStartOffset, relativeEndOffset, substring) => {
              switch (type) {
                case 'start-tag-name':
                case 'end-tag-name': {
                  if (substring.includes('-')) {
                    // We only care about custom elements (hence the “-”).
                    const offset = quasis[index].start;
                    const start = document.positionAt(offset + relativeStartOffset);
                    const end = document.positionAt(offset + relativeEndOffset);
                    tokens.push({ type, start, end, substring });
                  }
                  break;
                }
              }
            };
            try {
              XParser.parse(strings, onToken);
            } catch {
              // Ignore — we’ll take any tokens we can get.
            }
            templates.push({ start: templateStart, end: templateEnd, tokens });
          }
        },
        ClassDeclaration: path => {
          if (
            path?.node?.id?.name &&
            constructorNameToTagName[path.node.id.name]
          ) {
            const tagName = constructorNameToTagName[path.node.id.name];
            const startOffset = path.node.id.start;
            const endOffset = path.node.id.end;
            const start = document.positionAt(startOffset);
            const end = document.positionAt(endOffset);
            const properties = [];
            const propertiesNode = path.node.body?.body
              ?.find?.(candidate => (
                candidate.type === 'ClassMethod' &&
                candidate.static &&
                candidate.key?.name === 'properties'
              ));
            const returnStatementNode = propertiesNode?.body?.body
              ?.find?.(candidate => candidate.type === 'ReturnStatement');
            for (const propertyNode of returnStatementNode?.argument?.properties ?? []) {
              const property = {};
              property.key = propertyNode.key.name;
              property.range = {
                start: document.positionAt(propertyNode.key.start),
                end: document.positionAt(propertyNode.key.end),
              };
              const typeNode = propertyNode.value?.properties?.find?.(candidate => candidate.key.name === 'type');
              if (typeNode) {
                property.type = typeNode.value.name;
              }
              const internalNode = propertyNode.value?.properties?.find?.(candidate => candidate.key.name === 'internal');
              if (internalNode) {
                property.internal = internalNode.value.value === true;
              }
              const computeNode = propertyNode.value?.properties?.find?.(candidate => candidate.key.name === 'compute');
              if (computeNode) {
                property.readOnly = true;
              }
              const readOnlyNode = propertyNode.value?.properties?.find?.(candidate => candidate.key.name === 'readOnly');
              if (readOnlyNode) {
                property.readOnly = property.readOnly || readOnlyNode.value.value === true;
              }
              properties.push(property);
            }
            elements[tagName] = { constructor: { name: { start, end, name: path.node.id.name }, properties } };
          }
        },
        ImportDeclaration: path => {
          const value = path.node.source.value;
          const isLocalJsFile = value.match(/^\.+\/.*\.js$/);
          if (isLocalJsFile) {
            const importedFilePath = nodePath.resolve(nodePath.join(filePath, '../', value));
            const importedUri = vscodeUri.URI.file(importedFilePath).toString();
            imports.push({ uri: importedUri, filePath: importedFilePath });
          }
        },
      });
      Server.#documentCache.get(uri).analysis = { filePath, imports, elements, templates };

      // Parse direct imports as well (if not already parsed).
      if (templates.length && options.parseImports) {
        for (const importItem of imports) {
          if (!Server.#documentCache.get(importItem.uri).analysis) {
            try {
              const content = await Server.#readFile(importItem.filePath);
              const importedDocument = TextDocument.create(importItem.uri, 'javascript', 1, content);
              Server.#parseDocument(importedDocument);
            } catch {
              // Squelch error, we’ll ignore.
            }
          }
        }
      }
    } catch {
      // Parsing failed… that’s ok.
    }
  }

  //////////////////////////////////////////////////////////////////////////////
  // Insights //////////////////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  // Given pre-computed information, see if a document range can be looked up.
  static #findCustomElementDefinitionRange(elements, tagName) {
    const constructor = elements[tagName]?.constructor;
    if (constructor) {
      return { start: constructor.name.start, end: constructor.name.end };
    }
  }

  // Try and find the constructor for some tag name template token.
  static #findCustomElementDefinitionLink(document, templateToken) {
    const analysis = Server.#documentCache.get(document.uri).analysis;
    const tagName = templateToken.substring;
    const originSelectionRange = { start: templateToken.start, end: templateToken.end };

    const originDefinitionRange = Server.#findCustomElementDefinitionRange(analysis.elements, tagName);
    if (originDefinitionRange) {
      return {
        originSelectionRange,
        targetUri: document.uri,
        targetRange: originDefinitionRange,
        targetSelectionRange: originDefinitionRange,
      };
    } else {
      for (const importItem of analysis.imports) {
        const importedAnalysis = Server.#documentCache.get(importItem.uri).analysis;
        if (importedAnalysis) {
          const importedDefinitionRange = Server.#findCustomElementDefinitionRange(importedAnalysis.elements, tagName);
          if (importedDefinitionRange) {
            return {
              originSelectionRange,
              targetUri: importItem.uri,
              targetRange: importedDefinitionRange,
              targetSelectionRange: importedDefinitionRange,
            };
          }
        }
      }
    }
  }

  // See if the location the user is requesting relates to a template tag name.
  static #findCustomElementTemplateTokenAtPosition(templates, position) {
    for (const template of templates) {
      const templateStart = template.start;
      const templateEnd = template.end;
      if (
        Server.#isBefore(templateStart, position) &&
        Server.#isAfter(templateEnd, position)
      ) {
        for (const templateToken of template.tokens) {
          switch (templateToken.type) {
            case 'start-tag-name':
            case 'end-tag-name':
              if (
                Server.#isBefore(templateToken.start, position) &&
                Server.#isAfter(templateToken.end, position)
              ) {
                return templateToken;
              }
              break;
          }
        }
      }
    }
  }

  // Validate an already-analyzed document and provide diagnostics.
  static async #validateTextDocument(document) {
    // In this simple example we get the settings for every validate run.
    const settings = await Server.#getDocumentSettings(document.uri);

    const diagnostics = [];
    const analysis = Server.#documentCache.get(document.uri).analysis;
    if (analysis) {
      const templates = analysis.templates;
      if (templates.length > 0) {
        let count = 0;
        for (const template of templates) {
          for (const templateToken of template.tokens) {
            switch (templateToken.type) {
              case 'start-tag-name': {
                const definitionLink = Server.#findCustomElementDefinitionLink(document, templateToken);
                if (!definitionLink) {
                  count++;
                  const tagName = templateToken.substring;
                  const diagnostic = {
                    severity: DiagnosticSeverity.Warning,
                    range: {
                      start: templateToken.start,
                      end: templateToken.end,
                    },
                    message: `Could not find local or imported definition for <${tagName}>.`,
                    source: 'XElement',
                  };
                  diagnostics.push(diagnostic);
                }
              }
            }
            if (count >= settings.maxNumberOfProblems) {
              break;
            }
          }
          if (count >= settings.maxNumberOfProblems) {
            break;
          }
        }
      }
    }

    Server.#connection.sendDiagnostics({ uri: document.uri, diagnostics });
  }

  //////////////////////////////////////////////////////////////////////////////
  // Setup & Communication /////////////////////////////////////////////////////
  //////////////////////////////////////////////////////////////////////////////

  static #getDocumentSettings(documentUri) {
    if (!Server.#flags.hasConfigurationCapability) {
      return Promise.resolve(Server.#globalSettings);
    }
    if (!Server.#documentCache.get(documentUri).settings) {
      const scopeUri = documentUri;
      const section = 'XElement';
      const result = Server.#connection.workspace.getConfiguration({ scopeUri, section });
      Server.#documentCache.get(documentUri).settings = result;
    }
    return Server.#documentCache.get(documentUri).settings;
  }

  static #updateDocument(document) {
    if (document) {
      clearTimeout(Server.#requests[document.uri]);
      Server.#requests[document.uri] = setTimeout(async () => {
        // The content of a text document has changed. This event is emitted
        // when the text document first opened or when its content has changed.
        const filePath = nodeUrl.fileURLToPath(document.uri);
        Server.#connection.console.log(`analyzing ${filePath}`);
        const t0 = performance.now();
        await Server.#parseDocument(document, { parseImports: true });
        await Server.#validateTextDocument(document);
        const t1 = performance.now();
        const duration = t1 - t0;
        Server.#connection.console.log(`  done    took ${duration.toFixed(1)} ms`);
      }, Server.#delay);
    }
  }

  static #connectionOnInitialize(params) {
    const capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    Server.#flags.hasConfigurationCapability = !!(
      capabilities.workspace && !!capabilities.workspace.configuration
    );
    Server.#flags.hasWorkspaceFolderCapability = !!(
      capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    Server.#flags.hasDiagnosticRelatedInformationCapability = !!(
      capabilities.textDocument &&
      capabilities.textDocument.publishDiagnostics &&
      capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result = {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        // // Tell the client that this server supports code completion.
        // completionProvider: {
        //   resolveProvider: true,
        // },
        // Tell the client that this server supports diagnostics.
        diagnosticProvider: {
          interFileDependencies: false,
          workspaceDiagnostics: false,
        },
        // Tell the client that this server can link to definitions.
        definitionProvider: true,
        // Tell the client that this server can provide hover information.
        hoverProvider: true,
      },
    };
    if (Server.#flags.hasWorkspaceFolderCapability) {
      result.capabilities.workspace = {
        workspaceFolders: {
          supported: true,
        },
      };
    }
    return result;
  }

  static #connectionOnInitialized() {
    if (Server.#flags.hasConfigurationCapability) {
      // Register for all configuration changes.
      Server.#connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (Server.#flags.hasWorkspaceFolderCapability) {
      Server.#connection.workspace.onDidChangeWorkspaceFolders((/*_event*/) => {
      });
    }
  }

  static #connectionOnDidChangeConfiguration() {
    return change => {
      if (Server.#flags.hasConfigurationCapability) {
        // Reset all cached document settings
        Server.#documentCache.clear();
      } else {
        Server.#globalSettings = (
          (change.settings.languageServerExample || { ...Server.#defaultSettings })
        );
      }
      // Refresh the diagnostics since the `maxNumberOfProblems` could have changed.
      // We could optimize things here and re-fetch the setting first can compare it
      // to the existing setting, but this is out of scope for this example.
      Server.#connection.languages.diagnostics.refresh();
    };
  }

  static #connectionOnDefinition(params, token) {
    const document = Server.#documents.get(params.textDocument.uri);
    if (!document || token.isCancellationRequested) {
      return null;
    }

    const analysis = Server.#documentCache.get(document.uri).analysis;
    if (analysis) {
      const templateToken = Server.#findCustomElementTemplateTokenAtPosition(analysis.templates, params.position);
      if (templateToken) {
        return Server.#findCustomElementDefinitionLink(document, templateToken);
      }
    }
  }

  static #connectionOnHover(params, token) {
    const document = Server.#documents.get(params.textDocument.uri);
    if (!document || token.isCancellationRequested) {
      return null;
    }

    const analysis = Server.#documentCache.get(document.uri).analysis;
    if (analysis) {
      const templateToken = Server.#findCustomElementTemplateTokenAtPosition(analysis.templates, params.position);
      if (templateToken) {
        const definitionLink = Server.#findCustomElementDefinitionLink(document, templateToken);
        if (definitionLink) {
          const tagName = templateToken.substring;
          const targetAnalysis = Server.#documentCache.get(definitionLink.targetUri).analysis;
          const targetConstructorLink = Server.#createFileLink(definitionLink.targetUri, definitionLink.targetRange.start);
          const targetConstructor = targetAnalysis.elements[tagName].constructor;
          const value = [
            `**The [${tagName}](${targetConstructorLink}) element.**`,
            ...targetConstructor.properties
              .filter(property => !property.internal)
              .map(property => {
                const key = property.key;
                const link = Server.#createFileLink(definitionLink.targetUri, property.range.start);
                const maybeReadOnly = property.readOnly ? ' [read-only]' : '';
                const maybeType = property.type ? ` (${property.type})` : '';
                return `\n\n[${key}](${link})${maybeReadOnly}${maybeType}`;
              }),
          ].join('');
          const range = definitionLink.originSelectionRange;
          return { contents: { kind: 'markdown', value }, range };
        }
      }
    }
  }

  static #connectionOnCustomActiveDocumentChanged(params) {
    const document = Server.#documents.get(params.uri);
    Server.#updateDocument(document);
  }

  static #documentsOnDidClose(event) {
    // Only keep settings for open documents
    Server.#documentCache.get(event.document.uri).settings = null;
  }

  static #documentsOnDidChangeContent(change) {
    Server.#updateDocument(change.document);
  }

  static initialize() {
    // Client sent the initialize request.
    Server.#connection.onInitialize(Server.#connectionOnInitialize);

    // Client notifies that initialization is complete.
    Server.#connection.onInitialized(Server.#connectionOnInitialized);

    // Workspace or user settings changed.
    Server.#connection.onDidChangeConfiguration(Server.#connectionOnDidChangeConfiguration);

    // Custom notification we send from the client. Meant to improve diagnostics
    //  when switching back and forth through dependent files. See related
    //  commentary in the client script.
    Server.#connection.onNotification('custom/activeDocumentChanged', Server.#connectionOnCustomActiveDocumentChanged);

    // User initiated a “go-to-definition” request.
    Server.#connection.onDefinition(Server.#connectionOnDefinition);

    // User initiated a “hover” request.
    Server.#connection.onHover(Server.#connectionOnHover);

    // TODO: Find docs for this. We do get the following error if omitted:
    //  “Unhandled method textDocument/diagnostic“
    // Server.#connection.languages.diagnostics.on(Server.#connectionOnDiagnostics);
    Server.#connection.languages.diagnostics.on(() => {});

    Server.#documents.onDidClose(Server.#documentsOnDidClose);
    Server.#documents.onDidChangeContent(Server.#documentsOnDidChangeContent);

    Server.#documents.listen(Server.#connection);
    Server.#connection.listen();
  }
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
// Initialize our server singleton with connection instance.
Server.initialize();

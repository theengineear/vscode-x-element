const vscode = require('vscode');
const path = require('node:path');
const vscodeLanguageclient = require('vscode-languageclient/node');

let client;

function activate(context) {
  // The server is implemented in node
  const serverModule = context.asAbsolutePath(
    path.join('server', 'src', 'server.js')
  );

  // If the extension is launched in debug mode then the debug server options are used
  // Otherwise the run options are used
  const serverOptions = {
    run: { module: serverModule, transport: vscodeLanguageclient.TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: vscodeLanguageclient.TransportKind.ipc,
    },
  };

  // Options to control the language client
  const outputChannel = vscode.window.createOutputChannel('XElement Language Server');
  const clientOptions = {
    // Register the server for javascript text documents
    documentSelector: [{ scheme: 'file', language: 'javascript' }],
    outputChannel,
    synchronize: {
      // Notify the server about file changes to '.clientrc files contained in the workspace
      fileEvents: vscode.workspace.createFileSystemWatcher('**/.clientrc'),
    },
  };

  // Create the language client and start the client.
  client = new vscodeLanguageclient.LanguageClient(
    'languageServerExample',
    'Language Server Example',
    serverOptions,
    clientOptions
  );

  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor?.document) {
      // Notify language server that active document changed — this allows the
      //  server to re-parse that document to ensure it’s not showing stale
      //  diagnostics (e.g., after a imported dependency changes or something).
      const uri = editor.document.uri.toString();
      client.sendNotification('custom/activeDocumentChanged', { uri });
    }
  });

  // Start the client. This will also launch the server
  client.start();
}

function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

exports.activate = activate;
exports.deactivate = deactivate;

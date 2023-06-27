/* extension.ts - μScope vscode extension code */
/* Copyright 2023 Tom Smeets <tom@tsmeets.nl> */

// vscode api
import * as vscode from 'vscode';

// net is used to create sockets for the RTT connection
import * as net from 'net';

// fs is used to read files for reading the /media/index.html file
import * as fs from 'fs';

// child process will be used to spawn a gdb session which we use to connect to a gdb server
import * as cp from 'child_process';

/// global variables

// path of the extension. Used to access files in /media for example.
let extension_uri: vscode.Uri;

// vscode webview pane that contains our app
let view: vscode.WebviewView;

// socket connection to the J-link Gdb Server, usually port 19021.
// the connection is basically a telnet connection.
let socket: net.Socket | null;
let proc: cp.ChildProcessWithoutNullStreams | null;
let timer: NodeJS.Timer | null;


// called as soon as the 'uscope' panel becomes visible, which should be at launch
export function activate(context: vscode.ExtensionContext) {
    extension_uri = context.extensionUri;
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("uscope-view", new UScopeView(context.extensionUri), { webviewOptions: { retainContextWhenHidden: true } }));
}


// probably called when vscode exists or reloads
export function deactivate() {
    disconnect();
}

// Create a the socket connection to the rtt server. 'how' is used to decide wether to create a TCP socket or a connection over gdb.
function connect(host: string, port: number, how: string) {
    // try to disconnect, if we are still connected
    disconnect();

    // Receive RTT over GDB,
    // RTT normally only works with SEGGER J-Link devices
    // But we can read memory via gdb, so we implement the RTT protocol and read the data out
    if(how === "st-gdb" || how === "oc-gdb") {
        proc = cp.spawn("gdb", ['-q', '-nx', "--interpreter=mi"]);
        view_send({ host: host, port: port, type: "connect" }); 
        proc.stdout.on('error', ev => console.log('error', ev));

        // TODO: Some kind of error handling

        // non-stop mode, so we can read memory while still running
        proc.stdin.write("set non-stop on\n");

        // connect to the gdbserver
        proc.stdin.write("target remote " + host + ":" + port + "\n");

        // find the RTT Block structure, it always starts with the string "SEGGER RTT"
        proc.stdin.write('find /1 0x24000000, 0x24080000, "SEGGER RTT"\n');
        proc.stdin.write('set var $RTT=$_\n');

        // Define structure variables
        proc.stdin.write('set var $RTT_NAME  = *(char **)($RTT + 16 + 4*2 + 4*0)\n');
        proc.stdin.write('set var $RTT_BUF   = *(char **)($RTT + 16 + 4*2 + 4*1)\n');
        proc.stdin.write('set var $RTT_SIZE  = *(unsigned *)($RTT + 16 + 4*2 + 4*2)\n');
        proc.stdin.write('set var $RTT_WR    =  (unsigned *)($RTT + 16 + 4*2 + 4*3)\n');
        proc.stdin.write('set var $RTT_RD    =  (unsigned *)($RTT + 16 + 4*2 + 4*4)\n');
        proc.stdin.write('set var $RTT_FLAGS =  (unsigned *)($RTT + 16 + 4*2 + 4*5)\n');

        // Set blocking mode on
        // proc.stdin.write('p *$RTT_FLAGS=2\n');

        // continue running the program
        proc.stdin.write("continue &\n");

        // messages from gdb
        proc.stdout.on('data', data => {
            // very crude parsing of the 'output' data, rest is ignored
            const lines = data.toString().split("\n");
            for(const i in lines) {
                let value = lines[i];
                if(value.startsWith('~"\\"')) {
                    // strip the starting '~'
                    value = value.slice(1);

                    // the strings are encoded twice, use JSON.parse to unescape the '\n' and stuff.
                    try {
                        value = JSON.parse(value);
                        value = JSON.parse(value);

                        // send the message to the backend
                        view_send({  type: "message", value: value });
                    } catch (error) {                
                    }
                }
            }
        }); 

        timer = setInterval(() => {
            // This should never happen, but needed to make typescript happy
            // If the process is terminated we also stop the timer.
            // Depending on the scheduling it might be possible that this still runs
            // for one iteration. In that case we ignore it. The timer should be stopped for the next.
            if(!proc) return;

            // CUR_START, CUR_END indicate the memory region that contains the new RTT text
            // we store them now here because *$RTT_WR can change anytime.
            proc.stdin.write('set var $CUR_START=*$RTT_RD\n');
            proc.stdin.write('set var $CUR_END=*$RTT_WR\n');

            // If the start is after the end, it has wrapped around and the regions are now [cur_start..buffer_end] and [0..cur_end].
            // we output the first section [cur_start..buffer_end] and assing cur_start to 0 for the next section to handle.
            proc.stdin.write('if $CUR_START > $CUR_END\n');
            proc.stdin.write('output *($RTT_BUF+$CUR_START)@($RTT_SIZE-$CUR_START)\n');
            proc.stdin.write('set var $CUR_START=0\n');
            proc.stdin.write('end\n');

            // Output the text between CUR_START and CUR_END inside RTT_BUF.
            proc.stdin.write('output *($RTT_BUF+$CUR_START)@($CUR_END-$CUR_START)\n');
            // And advance the value of the read cursor to where we have read data
            proc.stdin.write('set var *$RTT_RD=$CUR_END\n');
        }, 50);
    } else {
        // everything else, that is not over gdb just uses a simple tcp socket
        socket = net.connect(port, host, () => { view_send({ host: host, port: port, type: "connect" }); });

        // forward all error messages to the webview
        socket.on('error', data => {
            view_send({ type: "error", value: data.message });

            // but we don't want to receive 'close' anymore now. So just remove that listener.
            // not perfect but this works.
            socket?.removeAllListeners();
        });

        // also forward close event and the message data
        socket.on('close', () => { view_send({ type: "close" }); });
        socket.on('data', data => view_send({  type: "message", value: data.toString() }));
    }
}

// close the socket if possible.
// does nothing if the socket was already closed
function disconnect() {
    if(timer) {
        clearInterval(timer);
        timer = null;
    }

    if(socket) {
        socket.destroy();
        socket = null;
    }

    if(proc) {
        proc.kill('SIGINT');
        proc = null;
    }
}

// call to send data to the webview. The data is structured as such:
// {
//   type: ...,
//   value: ...,
//   ...
// }
function view_send(data: any) {
    // console.log("view_send:", data);
    view.webview.postMessage(data);
}

// receive a message from the webview. So we can handle connecting, saving data and sending input.
function view_recv(data: any) {
    // (re)connect to the socket
    if(data.type === 'connect') {
        connect(data.host, data.port, data.how);
    }

    // send input to the socket, data.value is always a single line with no '\n' at the end.
    if(data.type === 'input') {
        const value: string = data.value;
        socket?.write(value);
    }

    // user wants to close the socket, so lets do that
    if(data.type === 'disconnect') {
        disconnect();
    }

    // save data as a text file, show a dialog so the user can choose a destination. The data.value is an array of all the lines.
    if(data.type === 'save') {
        vscode.window.showSaveDialog({ filters: { 'Text': ["txt"] } }).then(info => {
            if(info !== undefined) {
                fs.writeFileSync(info.fsPath, data.value.join(""));
            }
        });
    }
}

// Load the webview. We use 'media/index.html' as a reference and substitute the correct paths.
// This should only be called once on load. Calling again will clear the stored data in the webview.
function view_update() {
    view.webview.options = {
        enableScripts: true,
        localResourceRoots: [extension_uri]
    };

    // read the html from a file, so we don't need a big string here. But because the file is sent as text, we don't know what path it is.
    // We ask vscode for the paths of index.js and index.css and insert them into the html page.
    const uri_js  = view.webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, 'media', 'index.js'));
    const uri_css = view.webview.asWebviewUri(vscode.Uri.joinPath(extension_uri, 'media', 'index.css'));
    let html = fs.readFileSync(vscode.Uri.joinPath(extension_uri, 'media', 'index.html').fsPath).toString();
    html = html.replace("${uri_js}", uri_js.toString());
    html = html.replace("${uri_css}", uri_css.toString());
    view.webview.html = html;
    
    // received messages are forwarded to view_recv
    view.webview.onDidReceiveMessage(data => view_recv(data));
}

// Mandatory class for vscode. We just delegate the actual rendering
// to view_update() and use a global. This is ok because there will only ever be one.
class UScopeView implements vscode.WebviewViewProvider {
    constructor(readonly _extensionUri: vscode.Uri) { }
    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        // if we have not yet created the webview. Create it
        if(view === undefined) {
            view = webviewView;
            view_update();
        }
    }
}

// index.js - Main code that runs in the webview view
// Copyright 2023 Tom Smeets <tom@tsmeets.nl>

// NOTE: this file should be loaded after the DOM is loaded. So we can call 'document.getElementById'
// This can be done by using 'defer' or putting the <script> at the bottom of the page.

// console pane
const el_output = document.getElementById("output");
const el_input  = document.getElementById("input");
const el_filter = document.getElementById("filter");

// right pane
// selecting the connection type
const el_type    = document.getElementById("type");
const el_host    = document.getElementById("host");
const el_port    = document.getElementById("port");
const el_connect = document.getElementById("connect");

// tab bar elements
const el_tabbar   = document.getElementById("tabbar");
const el_tab_plus = document.getElementById("tab_plus");

// extra action buttons
const el_save   = document.getElementById("save");
const el_clear  = document.getElementById("clear");
const el_follow = document.getElementById("follow");
const el_filter_type = document.getElementById("filter_type");

// The vscode api for sending messages to 'extension.ts'
const vscode = acquireVsCodeApi();

// Global state, put inside an object for better visibility.
let cfg = {
    // maximum number of messages to display. Memory is not an issue here, but updating the html becomes slow eventually.
    // That is the disadvantage of this, i don't have any control over how the html is rendered and can't make it fast
    // without re-implementing the entire renderer.
    max_length: 4000,

    // socket connection state
    connected: false,

    // every single RTT line we received
    lines: [],

    // if a line was incomplete, append here
    line_progress: "",

    // Current open tab. This object is reassigned to the tab that we are currently viewing.
    // Tabs are stored in the tab_list. tab is assigned to the currently highlighted tab.
    tab: {
        // entire element of the tab text+close button
        el: null,

        // just the text element in the tab
        el_txt: null,

        // automatically scroll to the bottom in this tab?
        follow: true,

        // filter text entered for this tab
        filter_text: "",
        // can be 'simple' or 'regex'
        // simple is "simple to enter" but still has many features. We support 'or' '|' and 'and' '&' operators. And binds more closely.
        filter_type: 'simple',

        // for type = regex, we compile the regex only once per filter change
        filter_regex: null,
    },

    // list of all tabs, objects are the same as the tab object above
    tab_list: [],
};

// lets create the first tab
create_new_tab();

// Create a new tab and add it tot the tab-bar
// The new tab is then focused
function create_new_tab() {
    // create the HTML elements for the tab button
    // NOTE: classList is not actually a JavaScript list, but a space separated string
    // span: inline, div: display: block
    const el = document.createElement("span");
    el.classList = "tab";

    // text, and where to click to switch tab
    const el_txt = document.createElement("span");
    // el_txt.classList = "";

    // close button, closes the tab
    const el_close = document.createElement("a");
    el_close.classList = "icon";
    el_close.innerHTML = "x";


    // create a object containing information on the current tab, it is inserted in tab list but can also
    // be referenced here directly.
    let tab = {
        el: el,
        el_txt: el_txt,
        follow: true, // scroll output automatically
        filter_text: "",
        filter_regex: null, // can be null if the text is an invalid regex
        filter_type: 'simple'
    };

    // clicking the 'x' in the tab should close the tab, and switch to a different tab if needed
    function do_close() {
        // remove the tab from the tab list
        const ix = cfg.tab_list.indexOf(tab);
        if(ix < 0) return;
        cfg.tab_list.splice(ix, 1);

        // remove the html element
        el_tabbar.removeChild(tab.el);

        // if the tab is active, switch to a different one
        // only returns true of they are the actual same object reference
        if(tab === cfg.tab) {
            // if there are other tabs, we switch to the one next to it
            if(cfg.tab_list.length > 0) {
                // find next element to focus
                let j = ix;
                // if the right most tab was closed, switch to the tab before it
                if(j >= cfg.tab_list.length) j = cfg.tab_list.length-1;
                switch_tab(cfg.tab_list[j]);
            } else {
                // no tabs exist anymore, create at least one and switch to it
                create_new_tab();
            }
        }
    }

    // clicking anything but the close button should switch to the tab
    el.addEventListener("click",     ev => switch_tab(tab));
    el_txt.addEventListener("click", ev => switch_tab(tab));
    
    // clicking the 'x' closes the tab
    el_close.addEventListener("click", ev => do_close());

    // middle mouse button also closes the tab
    el.addEventListener("auxclick",       ev => { if(ev.button === 1) do_close(); });
    el_txt.addEventListener("auxclick",   ev => { if(ev.button === 1) do_close(); });
    el_close.addEventListener("auxclick", ev => { if(ev.button === 1) do_close(); });

    // insert before, because the '+' should stay at the end
    el.appendChild(el_txt);
    el.appendChild(el_close);
    el_tabbar.insertBefore(el, el_tab_plus);

    // switch to the new tab
    cfg.tab_list.push(tab);
    switch_tab(tab);
}

// compare the line to the current active filter
function line_matches(line) {

    // if the filter is just lowercase, ignore all case
    // so make the line also lowercase to ignore case altogether
    if(cfg.tab.ignore_case) {
        line = line.toLowerCase();
    }

    // Simple filter type
    // allows for two operators: OR '|'  and AND '&'
    // the 'and' binds more strongly than the or
    // so a&b|c&d filter lines that contain 'a' and 'b', but also the lines that contain c and d
    if(cfg.tab.filter_type === 'simple') {
        // first split on every 'or' sign. The '|'
        const filter_or = cfg.tab.filter_text.split("|");
        for (let i = 0; i < filter_or.length; i++) {

            // then split on every 'and' sign. The '&'
            // this way the and binds stronger which makes more sense for this case.
            const filter_and =  filter_or[i].split("&");

            // if all elements in the 'and' match, then this 'or' matches and the line matches.
            let has_all = true;
            for (let j = 0; j < filter_and.length; j++) {
                let filter = filter_and[j];

                // trim all spaces at the start and end, so those separating the '|' and '&' signs.
                // this makes sense in my opinion. Spaces between words are not stripped, which is also good.
                filter = filter.trim();

                // if one does not match, we are done with this 'or' part.
                if(!line.includes(filter)) {
                    has_all = false;
                    break;
                }
            }

            // if we have found a case, we are done and the line matches.
            if(has_all) return true;
        }

        // not a single 'or' matches, so the line is not included
        return false;
    }

    // Matching the regex is done with the builtin javascript regex class
    if(cfg.tab.filter_type === 'regex') {
        // if the regex failed to compile we default to matching every single message.
        if(cfg.tab.filter_regex === null) return true;
        return cfg.tab.filter_regex.exec(line) !== null;
    }

    // should not be reached, but whatever.
    return true;
}

// Change the current tab to the new tab
function switch_tab(tab_new) {
    // if the tab is already gone, don't switch to it
    const ix = cfg.tab_list.indexOf(tab_new);
    if(ix < 0) return;

    let tab_old = cfg.tab;

    // if there was a previous tab, mark it not active anymore
    if(tab_old.el !== null) {
        tab_old.el.classList = "tab";
    }

    // the new tab is now active
    tab_new.el.classList = "tab active";

    // let everyone know what the new tab is. This is not a copy but a reference.
    cfg.tab = tab_new;

    // the filter input element should reflect the state of the tab.
    el_filter.value = cfg.tab.filter_text;
    el_filter_type.value = cfg.tab.filter_type;

    // different tab means a different filter
    change_filter();
}

// Scroll to bottom, if enabled
function update_scroll() {
    // this is the best way i found to scroll to the bottom
    if(cfg.tab.follow) el_output.scrollTop = el_output.scrollHeight;
}

// Redraw the entire output console with the current active filter
function output_redraw() {
    // we accumulate all lines into a single string and set that as the element.
    // I measured this and it is significantly faster than appending tons of text elements directly.
    // NOTE: This is not very efficient given that we copy at every line, is there a string builder class?
    // according to this <https://stackoverflow.com/questions/2087522/does-javascript-have-a-built-in-stringbuilder-class> this is actually way
    // faster than a join. Bit strange, so maybe the browser does more smart things.
    let out = "";
    for(i in cfg.lines) {
        let line = cfg.lines[i];
        if(line_matches(line))
            out += line;
    }

    // innerText to prevent html elements injection
    el_output.innerText = out;

    // everything changed so scroll to the bottom again
    update_scroll();
}

// Send a message to the extension
function msg_send(data) {
    vscode.postMessage(data);
}

// Start the socket connection
function connect() {
    const host = el_host.value;
    const port = el_port.value;
    const type = el_type.value;
    el_connect.innerText = "Connecting...";
    msg_send({ type: 'connect', host: host, port: port, how: type });
}

// close the socket connection
function disconnect() {
    el_connect.innerText = "Connect";
    cfg.connected = false;
    msg_send({ type: 'disconnect' });
}

// We have connected to the socket
function on_connect() {
    el_connect.innerText = "Disconnect";
    cfg.connected = true;
}

// We failed to connect to the socket
function on_error() {
    el_connect.innerText = "Failed, Retry?";
}

// Connection was closed, the server went away or something
function on_disconnect() {
    el_connect.innerText = "Connect";
    cfg.connected = false;
}

// we changed the filter
function change_filter() {
    const filter = el_filter.value;
    cfg.tab.filter_text = filter;
    // smart case: if the filter is lowercase, we ignore all case.
    // A single upper case char makes the filter case sensitive.
    // if x == x.toLowerCase() then x is lowercase.
    cfg.tab.ignore_case = filter === filter.toLowerCase();
    cfg.tab.filter_regex = null;
    
    // for regex filters, compile the regex
    if(cfg.tab.filter_type === 'regex') {
        try {
            cfg.tab.filter_regex = new RegExp(filter, cfg.tab.ignore_case ? "i" : "");
            el_filter.style = "";
        } catch {
            // cool red border if the regex is invalid
            cfg.tab.filter_regex = null;
            el_filter.style = "outline: 2px solid red !important; outline-offset: -1px";
        }
    }

    // just scroll to bottom, probably good default behavior
    cfg.tab.follow = true;

    // update tab text, but put something else in place for an empty filter, as that would be confusing.
    if(filter === "") {
        cfg.tab.el_txt.innerHTML = "<i>No filter</i>";
    } else {
        cfg.tab.el_txt.innerText = filter;
    }

    // filter changed -> need a full redraw
    output_redraw();
}

// we got a new line from the connection
function append_line(line) {
    cfg.lines.push(line);
    
    if(line_matches(line)) {
        // individual lines are added as elements, so a minimal amount of html has to be changed
        // only on filter change do we completely redraw the lines and use a single element.
        el_output.appendChild(document.createTextNode(line));
    }

    // reduce the number of messages, the html rendrer
    // becomes laggy after a given number of lines.
    // This is done in chuncks to limit the rate
    // where the entire screen is re rendred.
    if(cfg.lines.length >= cfg.max_length) {
        cfg.lines.splice(0, cfg.max_length / 4);
        output_redraw();
    }
}

// We got some input we need to send to the device
function send_input() {
    // Always terminate the line with a newline symbol
    const value = el_input.value + "\n";

    // forward to extension.ts
    msg_send({ type: 'input', value: value });

    // show the input line in the console
    append_line("> " + value);

    // after sending clear the input field again
    el_input.value = "";
}

// Connect button
el_connect.addEventListener("click", event => {
    if(!cfg.connected) {
        connect();
    } else {
        disconnect();
    }
});

// Command input text, enter = send
el_input.addEventListener("keydown", event => {
    if (event.key === "Enter") send_input();
});

// Filter changed, immediately update the console, because that is cool
el_filter.addEventListener("input", event => {
    change_filter();
});


// clicking on the output text should stop the scrolling
el_output.addEventListener("click", event => {
    cfg.tab.follow = false;
    update_scroll();
});

// clicking the follow button should always enable scroll to bottom again
el_follow.addEventListener("click", event => {
    cfg.tab.follow = true;
    update_scroll();
});

// messages that are sent by extension.ts, contains connection information and the rtt messages.
window.addEventListener('message', event => {
    const data = event.data;

    // socket state
    if(data.type === 'connect') on_connect();
    if(data.type === 'error')   on_error();
    if(data.type === 'close')   on_disconnect();

    // scoket message
    if(data.type === 'message') {
        const message = cfg.line_progress + data.value; // The json data that the extension sent

        // the message can contain multiple lines, so split for every line.
        // the last line might be cut off, but usually that it is fine to ignore that.
        const msg_lines = message.split("\n");

        // Last line is either an incomplete line, or a empty string
        cfg.line_progress = msg_lines.pop();

        for(i in msg_lines) {
            let line = msg_lines[i];

            // ignore empty lines.
            if(line === "") continue;

            // each line also has the '\n' still in there
            line += "\n";

            // draw the line
            append_line(line);
        }

        // scroll down to the new lines
        update_scroll();
    }
});

// create new tabs with the new tab '+' button
el_tab_plus.addEventListener("click", ev => {
    create_new_tab();
});

// clear console output
el_clear.addEventListener("click", ev => {
    cfg.lines = [];
    output_redraw();
});

// save console output, now just everything, but could potentially be the filtered list.
el_save.addEventListener("click", ev => {
    msg_send({ type: 'save', value: cfg.lines });
});

// if the filter type changed, recompile the filter and update the output console.
el_filter_type.addEventListener("change", ev => { cfg.tab.filter_type = el_filter_type.value; change_filter(); });

// connection type, changes the port. The '-gdb' versions also start gdb and use that to communicate over RTT.
el_type.addEventListener("change", ev => {
    if(el_type.value === "jl-rtt")
        el_port.value = "19021";

    if(el_type.value === "jl-swo")
        el_port.value = "2332";

    if(el_type.value === "jl-telnet")
        el_port.value = "2333";

    if(el_type.value === "st-swo")
        el_port.value = "61235";

    if(el_type.value === "st-gdb")
        el_port.value = "61234";

    if(el_type.value === "oc-gdb")
        el_port.value = "3333";

    if(el_type.value === "oc-swo")
        el_port.value = "3344";
});

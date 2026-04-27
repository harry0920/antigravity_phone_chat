#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync, exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const POLL_INTERVAL = 1000; // 1 second
const SERVER_PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';
const WORKSPACES_FILE = join(__dirname, 'workspaces.json');

// Workspace state
let workspaces = [];
let cdpConnections = new Map(); // Map<port, connection>

function loadWorkspaces() {
    try {
        if (fs.existsSync(WORKSPACES_FILE)) {
            workspaces = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
            if (workspaces.length > 0 && !currentWorkspaceId) {
                currentWorkspaceId = workspaces[0].id;
            }
        }
    } catch (e) {
        console.error('❌ Failed to load workspaces:', e.message);
    }
}
loadWorkspaces();

// Security warning for default credentials
if (APP_PASSWORD === 'antigravity') {
    console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default APP_PASSWORD ("antigravity").');
    console.warn('\x1b[33m%s\x1b[0m', '   Set a strong APP_PASSWORD in your .env file for production use.\n');
}

// Note: hashString is defined later, so we'll initialize the token inside createServer or use a simple string for now.
let AUTH_TOKEN = 'ag_default_token';


// Shared CDP connection
let lastSnapshot = null;
let lastSnapshotHash = null;

// Kill any existing process on the server port (prevents EADDRINUSE)
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            // Windows: Find PID using netstat and kill it
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            // Linux/macOS: Use lsof and kill
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
        // Small delay to let the port be released
        return new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
        // No process found on port - this is fine
        return Promise.resolve();
    }
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Find Antigravity CDP endpoint for a specific port or list of ports
async function discoverCDP(targetPort = null, targetPath = null) {
    const errors = [];
    const portsToScan = targetPort ? [targetPort] : PORTS;
    
    const folderName = targetPath ? targetPath.split(/[\\/]/).pop().replace('.code-workspace', '') : null;

    for (const port of portsToScan) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            if (folderName) {
                const searchName = folderName.toLowerCase();
                const searchNameNoPlus = searchName.replace(/\s?\+\s?/g, ' ').trim();
                const searchNameUnderscore = searchName.replace(/\s+/g, '_');

                const match = list.find(t => {
                    if (!t.url?.includes('workbench.html')) return false;
                    const title = t.title?.toLowerCase() || '';
                    return title.includes(searchName) || 
                           title.includes(searchNameNoPlus) || 
                           title.includes(searchNameUnderscore);
                });

                if (match && match.webSocketDebuggerUrl) {
                    return { port, url: match.webSocketDebuggerUrl, title: match.title };
                }
            }

            const workbench = list.find(t => t.url?.includes('workbench.html'));
            if (workbench && workbench.webSocketDebuggerUrl) {
                return { port, url: workbench.webSocketDebuggerUrl, title: workbench.title };
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    throw new Error(`CDP not found. ${errors.join(', ')}`);
}

// Get or create connection for a port
async function getConnection(port, targetPath = null) {
    let conn = cdpConnections.get(Number(port));
    if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return conn;
    }

    // Try to discover and connect
    try {
        const target = await discoverCDP(port, targetPath);
        console.log(`🔌 Connecting to Antigravity on port ${port}...`);
        const newConn = await connectCDP(target.url);
        newConn.port = port;
        newConn.title = target.title;
        cdpConnections.set(Number(port), newConn);
        return newConn;
    } catch (err) {
        return null;
    }
}

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, contexts };
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(async () => {
        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) {
            // Debug info
            const body = document.body;
            const childIds = Array.from(body.children).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Mark fixed/absolute elements in the original DOM before cloning
        // This is the only way to reliably catch CSS-class-based positioning
        const candidates = cascade.querySelectorAll('*');
        candidates.forEach(el => {
            try {
                const pos = window.getComputedStyle(el).position;
                if (pos === 'fixed' || pos === 'absolute') {
                    el.setAttribute('data-ag-rem', 'true');
                }
            } catch(e) {}
        });

        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        
        // Clean up markers from the original DOM immediately after cloning
        candidates.forEach(el => el.removeAttribute('data-ag-rem'));
        
        // Aggressively remove the entire interaction/input/review area
        try {
            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]',
                '[data-lexical-editor]',
                'form',
                // New aggressive selectors for recent Antigravity versions
                '.mx-8.mb-8',
                '.mx-4.mb-4',
                '.fixed.bottom-0',
                '.absolute.bottom-0'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // Protect elements that contain interactive buttons the user might need
                        const text = (el.innerText || '').toLowerCase();
                        const isActionArea = text.includes('allow') || text.includes('deny') || 
                                           text.includes('review') || text.includes('run') ||
                                           text.includes('confirm');
                        
                        // BUT: If it's specifically an input-related element, we DON'T protect it
                        const isEditor = el.getAttribute('contenteditable') === 'true' || 
                                       el.hasAttribute('data-lexical-editor') ||
                                       text.includes('ask anything') ||
                                       text.includes('to mention');
                        if (!isEditor && isActionArea && selector !== '[contenteditable="true"]') {
                            return; // Protect action bars
                        }

                        // For the editor or its container, remove it
                        // Go up to find the main floating box if it's a deep selector
                        let targetToRemove = el;
                        if (isEditor || selector.includes('bottom-0')) {
                             // Find the common container for the input box (usually has margins or padding)
                             let parent = el.parentElement;
                             for (let i = 0; i < 4; i++) {
                                 if (!parent || parent === clone) break;
                                 const pCls = (parent.className || '').toString();
                                 if (pCls.includes('mx-') || pCls.includes('mb-') || pCls.includes('bg-')) {
                                     targetToRemove = parent;
                                 }
                                 parent = parent.parentElement;
                             }
                        }
                        
                        if (targetToRemove && targetToRemove !== clone) {
                            targetToRemove.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            // 2. Text-based cleanup for stray status bars and redundant desktop inputs
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
                    const isInputPlaceholder = text.includes('ask anything') || 
                                              text.includes('to mention') || 
                                              placeholder.includes('ask anything');
                    
                    // IF it's the main chat box (contains placeholder text), remove its container
                    if (isInputPlaceholder) {
                        // Find the container (usually a few levels up)
                        let container = el;
                        for (let i = 0; i < 5; i++) {
                            if (!container.parentElement || container.parentElement === clone) break;
                            const cls = (container.className || '').toString();
                            if (cls.includes('flex-col') || cls.includes('input') || cls.includes('area')) {
                                container.remove();
                                return;
                            }
                            container = container.parentElement;
                        }
                        el.remove();
                        return;
                    }
                } catch(e) {}
            });

            // 3. NUCLEAR: If any editor or redundant UI remains, remove its entire branch
            const redundantElements = clone.querySelectorAll('[contenteditable="true"], [data-lexical-editor], [role="textbox"], form, .mx-8.mb-8, .mx-4.mb-4');
            redundantElements.forEach(el => {
                try {
                    let branch = el;
                    // Go up to find the highest container that is still within the clone
                    // This ensures we remove the entire "box" (with chips, submit btn, etc)
                    while (branch.parentElement && branch.parentElement !== clone) {
                        const p = branch.parentElement;
                        const pCls = (p.className || '').toString().toLowerCase();
                        // Stop going up if we hit a main message/conversation wrapper
                        if (pCls.includes('message') || pCls.includes('bubble') || pCls.includes('conversation')) break;
                        branch = p;
                    }
                    if (branch && branch !== clone) branch.remove();
                    else el.remove();
                } catch(e) {}
            });

            // 4. Force hide any fixed/absolute elements (desktop overlays)
            // These were marked in the original before cloning to ensure accurate computed styles
            clone.querySelectorAll('[data-ag-rem]').forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    // Exclude Action Bars we want to keep
                    if (text.includes('allow') || text.includes('deny') || text.includes('review')) {
                        el.removeAttribute('data-ag-rem');
                        return;
                    }
                    el.remove();
                } catch(e) {}
            });
        } catch (globalErr) { }

        // Convert local images to base64
        const images = clone.querySelectorAll('img');
        const promises = Array.from(images).map(async (img) => {
            const rawSrc = img.getAttribute('src');
            if (rawSrc && (rawSrc.startsWith('/') || rawSrc.startsWith('vscode-file:')) && !rawSrc.startsWith('data:')) {
                try {
                    const res = await fetch(rawSrc);
                    const blob = await res.blob();
                    await new Promise(r => {
                        const reader = new FileReader();
                        reader.onloadend = () => { img.src = reader.result; r(); };
                        reader.onerror = () => r();
                        reader.readAsDataURL(blob);
                    });
                } catch(e) {}
            }
        });
        await Promise.all(promises);

        // Fix inline file references: Antigravity nests <div> elements inside
        // <span> and <p> tags (e.g. file-type icons). Browsers auto-close <p> and
        // <span> when they encounter a <div>, causing unwanted line breaks.
        // Solution: Convert any <div> inside an inline parent to a <span>.
        try {
            const inlineTags = new Set(['SPAN', 'P', 'A', 'LABEL', 'EM', 'STRONG', 'CODE']);
            const allDivs = Array.from(clone.querySelectorAll('div'));
            for (const div of allDivs) {
                try {
                    if (!div.parentNode) continue;
                    const parent = div.parentElement;
                    if (!parent) continue;
                    
                    const parentIsInline = inlineTags.has(parent.tagName) || 
                        (parent.className && (parent.className.includes('inline-flex') || parent.className.includes('inline-block')));
                        
                    if (parentIsInline) {
                        const span = document.createElement('span');
                        // MOVE children instead of copying (prevents orphaning nested divs)
                        while (div.firstChild) {
                            span.appendChild(div.firstChild);
                        }
                        if (div.className) span.className = div.className;
                        if (div.getAttribute('style')) span.setAttribute('style', div.getAttribute('style'));
                        span.style.display = 'inline-flex';
                        span.style.alignItems = 'center';
                        span.style.verticalAlign = 'middle';
                        div.replaceWith(span);
                    }
                } catch(e) {}
            }
        } catch(e) {}
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\\n');
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length
            }
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                // console.log(`Context ${ctx.id} exception:`, result.exceptionDetails);
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    // console.log(`Context ${ctx.id} script error:`, val.error);
                    // if (val.debug) console.log(`   Debug info:`, JSON.stringify(val.debug));
                } else {
                    return val;
                }
            }
        } catch (e) {
            console.log(`Context ${ctx.id} connection error:`, e.message);
        }
    }

    return null;
}

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
        const debug = [];
        
        // Check if AI is currently generating
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        // === PHASE 1: Find the editor ===
        // Strategy A: Search inside known containers (original approach)
        let editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null);
        debug.push('A: container editors=' + editors.length);

        // Strategy B: Search for Lexical editors (used by many Electron chat UIs)
        if (editors.length === 0) {
            editors = [...document.querySelectorAll('[data-lexical-editor="true"], [data-lexical-editor]')]
                .filter(el => el.offsetParent !== null);
            debug.push('B: lexical editors=' + editors.length);
        }

        // Strategy C: Global contenteditable search (broadest fallback)
        if (editors.length === 0) {
            editors = [...document.querySelectorAll('[contenteditable="true"]')]
                .filter(el => el.offsetParent !== null && el.offsetHeight > 10);
            debug.push('C: global contenteditable=' + editors.length);
        }

        // Strategy D: Textarea / input fallback
        if (editors.length === 0) {
            editors = [...document.querySelectorAll('textarea, input[type="text"]')]
                .filter(el => el.offsetParent !== null && (
                    el.placeholder?.toLowerCase().includes('message') ||
                    el.placeholder?.toLowerCase().includes('ask') ||
                    el.placeholder?.toLowerCase().includes('type') ||
                    el.placeholder?.toLowerCase().includes('chat') ||
                    el.getAttribute('aria-label')?.toLowerCase().includes('message') ||
                    el.getAttribute('aria-label')?.toLowerCase().includes('chat')
                ));
            debug.push('D: textarea/input=' + editors.length);
        }

        // Strategy E: Role=textbox (ARIA pattern)
        if (editors.length === 0) {
            editors = [...document.querySelectorAll('[role="textbox"]')]
                .filter(el => el.offsetParent !== null);
            debug.push('E: role=textbox=' + editors.length);
        }

        const editor = editors.at(-1);
        if (!editor) {
            // Collect diagnostic info about the page
            const allCE = document.querySelectorAll('[contenteditable]');
            const allTA = document.querySelectorAll('textarea');
            const allInput = document.querySelectorAll('input');
            const bodyIds = Array.from(document.body.children).map(c => c.id || c.tagName).filter(Boolean).join(', ');
            return { 
                ok:false, 
                error:"editor_not_found",
                debug: debug.join(' | '),
                diagnostics: {
                    contentEditableCount: allCE.length,
                    textareaCount: allTA.length,
                    inputCount: allInput.length,
                    bodyChildren: bodyIds,
                    url: window.location?.href?.substring(0, 100) || 'unknown'
                }
            };
        }
        debug.push('Using editor: tag=' + editor.tagName + ' class=' + (editor.className || '').toString().substring(0, 60));

        const textToInsert = ${safeText};

        // === PHASE 2: Insert text ===
        const isTextarea = editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT';
        
        if (isTextarea) {
            // For native form elements
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                editor.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
                'value'
            ).set;
            nativeInputValueSetter.call(editor, textToInsert);
            editor.dispatchEvent(new Event('input', { bubbles: true }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            debug.push('Inserted via native setter');
        } else {
            // For contenteditable elements
            editor.focus();
            document.execCommand?.("selectAll", false, null);
            document.execCommand?.("delete", false, null);

            let inserted = false;
            try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
            if (!inserted) {
                editor.textContent = textToInsert;
                editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
                editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
            }
            debug.push('Inserted via ' + (inserted ? 'execCommand' : 'textContent fallback'));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        // === PHASE 3: Find and click submit button ===
        // Strategy 1: Lucide arrow-right SVG (original)
        let submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
        
        // Strategy 2: Lucide send icon
        if (!submit) submit = document.querySelector("svg.lucide-send, svg.lucide-arrow-up")?.closest("button");
        
        // Strategy 3: data-tooltip-id patterns
        if (!submit) submit = document.querySelector('[data-tooltip-id*="send"], [data-tooltip-id*="submit"]');
        
        // Strategy 4: aria-label patterns  
        if (!submit) {
            const allBtns = Array.from(document.querySelectorAll('button'));
            submit = allBtns.find(b => {
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                const title = (b.getAttribute('title') || '').toLowerCase();
                return (label.includes('send') || label.includes('submit') || title.includes('send')) && b.offsetParent !== null && !b.disabled;
            });
        }
        
        // Strategy 5: Button near the editor (sibling or parent's sibling)
        if (!submit) {
            let searchScope = editor.parentElement;
            for (let i = 0; i < 4 && searchScope; i++) {
                const btns = Array.from(searchScope.querySelectorAll('button')).filter(b => b.offsetParent !== null && !b.disabled);
                // Find a button that has an SVG icon and is likely a send button
                const candidate = btns.find(b => b.querySelector('svg') && b !== editor);
                if (candidate) {
                    submit = candidate;
                    break;
                }
                searchScope = searchScope.parentElement;
            }
        }

        if (submit && !submit.disabled) {
            submit.click();
            debug.push('Submit: clicked button');
            return { ok:true, method:"click_submit", debug: debug.join(' | ') };
        }

        // Fallback: trigger Enter key on the editor
        debug.push('Submit: Enter key fallback (no button found)');
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter", keyCode:13 }));
        editor.dispatchEvent(new KeyboardEvent("keypress", { bubbles:true, key:"Enter", code:"Enter", keyCode:13 }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter", keyCode:13 }));
        
        return { ok:true, method:"enter_keypress", debug: debug.join(' | ') };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeText = JSON.stringify(textContent || '');

    const EXP = `(async () => {
        try {
            // Priority: Search inside the chat container first for better accuracy
            const root = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade') || document;
            
            // Strategy: Find all elements matching the selector
            let elements = Array.from(root.querySelectorAll('${selector}'));
            
            const filterText = ${safeText};
            if (filterText) {
                elements = elements.filter(el => {
                    const txt = (el.innerText || el.textContent || '').trim();
                    const firstLine = txt.split('\\n')[0].trim();
                    // Match if first line matches (thought blocks) or if it contains the label (buttons)
                    return firstLine === filterText || txt.includes(filterText);
                });
                
                // CRITICAL: If elements are nested (e.g. <div><span>Text</span></div>), 
                // both will match. We only want the most specific (inner-most) one.
                elements = elements.filter(el => {
                    return !elements.some(other => other !== el && el.contains(other));
                });
            }

            const target = elements[${index}];

            if (target) {
                // Focus and Click
                if (target.focus) target.focus();
                target.click();
                return { success: true, found: elements.length, indexUsed: ${index} };
            }
            
            return { error: 'Element not found at index ' + ${index} + ' among ' + elements.length + ' matches' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
            // If we found it but click didn't return success (unlikely with this script), continue to next context
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts or element not found at index' };
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-tooltip-id patterns (most reliable)
            modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}
// Get Chat History - Click history button and scrape conversations
async function getChatHistory(cdp) {
    const EXP = `(async () => {
        try {
            const chats = [];
            const seenTitles = new Set();

            // Priority 1: Look for tooltip ID pattern (history/past/recent)
            let historyBtn = document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"], [data-tooltip-id*="conversation-history"]');
            
            // Priority 2: Look for button ADJACENT to the new chat button
            if (!historyBtn) {
                const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
                if (newChatBtn) {
                    const parent = newChatBtn.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(el => el !== newChatBtn);
                        historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
                    }
                }
            }

            // Fallback: Use previous heuristics (icon/aria-label)
            if (!historyBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a[data-tooltip-id]'));
                for (const btn of allButtons) {
                    if (btn.offsetParent === null) continue;
                    const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                                           btn.querySelector('svg.lucide-history') ||
                                           btn.querySelector('svg.lucide-folder') ||
                                           btn.querySelector('svg[class*="clock"]') ||
                                           btn.querySelector('svg[class*="history"]');
                    if (hasHistoryIcon) {
                        historyBtn = btn;
                        break;
                    }
                }
            }
            
            if (!historyBtn) {
                return { error: 'History button not found', chats: [] };
            }

            // Click and Wait
            historyBtn.click();
            await new Promise(r => setTimeout(r, 2000));
            
            // Find the side panel
            let panel = null;
            let inputsFoundDebug = [];
            
            // Strategy 1: The search input has specific placeholder
            let searchInput = null;
            const inputs = Array.from(document.querySelectorAll('input'));
            searchInput = inputs.find(i => {
                const ph = (i.placeholder || '').toLowerCase();
                return ph.includes('select') || ph.includes('conversation');
            });
            
            // Strategy 2: Look for any text input that looks like a search bar (based on user snippet classes)
            if (!searchInput) {
                const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
                inputsFoundDebug = allInputs.map(i => 'ph:' + i.placeholder + ', cls:' + i.className);
                
                searchInput = allInputs.find(i => 
                    i.offsetParent !== null && 
                    (i.className.includes('w-full') || i.classList.contains('w-full'))
                );
            }
            
            // Strategy 3: Find known text in the panel (Anchor Text Strategy)
            let anchorElement = null;
            if (!searchInput) {
                 const allSpans = Array.from(document.querySelectorAll('span, div, p'));
                 anchorElement = allSpans.find(s => {
                     const t = (s.innerText || '').trim();
                     return t === 'Current' || t === 'Refining Chat History Scraper'; // specific known title
                 });
            }

            const startElement = searchInput || anchorElement;

            if (startElement) {
                // Walk up to find the panel container
                let container = startElement;
                for (let i = 0; i < 15; i++) { 
                    if (!container.parentElement) break;
                    container = container.parentElement;
                    const rect = container.getBoundingClientRect();
                    
                    // Panel should have good dimensions
                    // Relaxed constraints for mobile
                    if (rect.width > 50 && rect.height > 100) {
                        panel = container;
                        
                        // If it looks like a modal/popover (fixed or absolute pos), that's definitely it
                        const style = window.getComputedStyle(container);
                        if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                            break;
                        }
                    }
                }
                
                // Fallback if loop finishes without specific break
                if (!panel && startElement) {
                     // Just go up 4 levels
                     let p = startElement;
                     for(let k=0; k<4; k++) { if(p.parentElement) p = p.parentElement; }
                     panel = p;
                }
            }
            
            const debugInfo = { 
                panelFound: !!panel, 
                panelWidth: panel?.offsetWidth || 0,
                inputFound: !!searchInput,
                anchorFound: !!anchorElement,
                inputsDebug: inputsFoundDebug.slice(0, 5)
            };
            
            if (panel) {
                // Chat titles are in <span> elements
                const spans = Array.from(panel.querySelectorAll('span'));
                
                // Section headers and workspace labels to skip
                const SKIP_EXACT = new Set([
                    'current', 'other conversations', 'now',
                    'projects', 'personal', 'workspace', 'default', 'phone connect antigravity'
                ]);
                
                for (const span of spans) {
                    const text = span.textContent?.trim() || '';
                    const lower = text.toLowerCase();
                    
                    // Skip empty or too short
                    if (text.length < 3) continue;

                    // Sibling-span heuristic: skip tag/badge labels (like workspaces)
                    // If a short span has a longer sibling span, it's likely a tag next to the actual title
                    if (text.length < 40 && span.parentElement) {
                        let hasLongerSiblingSpan = false;
                        for (const child of span.parentElement.children) {
                            if (child !== span && child.tagName === 'SPAN') {
                                const childTextLength = (child.textContent?.trim() || '').length;
                                if (childTextLength > text.length) {
                                    hasLongerSiblingSpan = true;
                                    break;
                                }
                            }
                        }
                        if (hasLongerSiblingSpan) continue;
                    }
                    
                    // Skip section headers
                    if (SKIP_EXACT.has(lower)) continue;
                    if (lower.startsWith('recent in ')) continue;
                    if (lower.startsWith('show ') && lower.includes('more')) continue;
                    
                    // Skip timestamps
                    if (lower.endsWith(' ago') || /^\\d+\\s*(sec|min|hr|day|wk|mo|yr)/i.test(lower)) continue;
                    
                    // Skip very long text (containers)
                    if (text.length > 100) continue;
                    
                    // Skip duplicates
                    if (seenTitles.has(text)) continue;
                    
                    seenTitles.add(text);
                    chats.push({ title: text, date: 'Recent' });
                    
                    if (chats.length >= 50) break;
                }
            }
            
            // Note: Panel is left open on PC as requested ("launch history on pc")

            return { success: true, chats: chats, debug: debugInfo };
        } catch(e) {
            return { error: e.toString(), chats: [] };
        }
    })()`;

    let lastError = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
            // If result.value is null/undefined but no error thrown, check exceptionDetails
            if (res.exceptionDetails) {
                lastError = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            }
        } catch (e) {
            lastError = e.message;
        }
    }
    return { error: 'Context failed: ' + (lastError || 'No contexts available'), chats: [] };
}

async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);

    const EXP = `(async () => {
        try {
            const targetTitle = ${safeChatTitle};
            let debugInfo = [];
            const log = (msg) => debugInfo.push(msg);
            log('Starting selectChat for: ' + targetTitle);

            // 1. Open History Panel (same robust method style as getChatHistory)
            let historyBtn = document.querySelector('[data-tooltip-id="history-tooltip"]');
            
            if (!historyBtn) {
                const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
                
                // Try icon first
                historyBtn = allButtons.find(btn => {
                    if (btn.offsetParent === null) return false;
                    return btn.querySelector('svg.lucide-clock') ||
                        btn.querySelector('svg.lucide-history') ||
                        btn.querySelector('svg.lucide-folder') ||
                        btn.querySelector('svg.lucide-clock-rotate-left');
                });
                
                // Try position strategy (second button near new chat)
                if (!historyBtn) {
                    const topButtons = allButtons.filter(btn => {
                        if (btn.offsetParent === null) return false;
                        const rect = btn.getBoundingClientRect();
                        return rect.top < 100 && rect.top > 0;
                    }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
                    
                    if (topButtons.length >= 2) historyBtn = topButtons[1];
                }
            }

            if (!historyBtn) return { error: 'History button not found', debug: debugInfo };

            historyBtn.click();
            log('Clicked history button');

            // 2. Wait-for-visible polling (up to 3s)
            let panel = null;
            let panelFound = false;
            for (let i = 0; i < 15; i++) {
                await new Promise(r => setTimeout(r, 200));

                const inputs = Array.from(document.querySelectorAll('input[type="text"]'));
                const searchInput = inputs.find(input =>
                    input.offsetParent !== null &&
                    (input.placeholder?.toLowerCase().includes('select') ||
                     input.placeholder?.toLowerCase().includes('conversation') ||
                     input.className.includes('w-full'))
                );

                const allSpans = Array.from(document.querySelectorAll('span, div, p'));
                const anchorSpan = allSpans.find(s => s.offsetParent !== null && (s.innerText || '').trim() === 'Current');

                const anchor = searchInput || anchorSpan;
                if (anchor) {
                    let container = anchor;
                    for (let j = 0; j < 15; j++) {
                        if (!container) break;
                        const rect = container.getBoundingClientRect();
                        if (rect.width > 50 && rect.height > 100) {
                            const style = window.getComputedStyle(container);
                            if (style.position === 'fixed' || style.position === 'absolute' || style.zIndex > 10) {
                                panel = container;
                                panelFound = true;
                                break;
                            }
                        }
                        container = container.parentElement;
                    }
                }
                if (panelFound) break;
            }

            if (!panelFound) return { error: 'History panel did not open', debug: debugInfo };
            log('Panel found');

            // Give panel a bit more time to render list items
            await new Promise(r => setTimeout(r, 300));

            // 3. Scored fuzzy matching
            let candidates = Array.from(panel.querySelectorAll('span, p, div'))
                .filter(el => {
                    const text = el.textContent?.trim() || '';
                    return text.length >= 3 && el.children.length === 0 && el.offsetParent !== null;
                })
                .map(el => {
                    const text = el.textContent.trim();
                    const targetLower = targetTitle.toLowerCase();
                    const textLower = text.toLowerCase();

                    let score = 0;
                    if (text === targetTitle) score += 100;
                    else if (textLower === targetLower) score += 90;
                    else if (text.includes(targetTitle)) score += 60;
                    else if (textLower.includes(targetLower)) score += 50;
                    else if (targetLower.includes(textLower)) score += 40;
                    else if (textLower.startsWith(targetLower.substring(0, Math.min(20, targetLower.length)))) score += 30;

                    // Penalty for tiny labels/tags
                    if (text.length < 5) score -= 10;

                    // Bonus for deeper nodes (usually more specific)
                    let depth = 0;
                    let p = el;
                    while (p) { depth++; p = p.parentElement; }
                    score += depth;

                    return { el, text, score };
                })
                .filter(c => c.score >= 30)
                .sort((a, b) => b.score - a.score);

            if (candidates.length === 0) return { error: 'Chat title not found in panel', title: targetTitle, debug: debugInfo };

            log('Found ' + candidates.length + ' candidates. Best match: "' + candidates[0].text + '" (Score: ' + candidates[0].score + ')');

            // 4. Click execution with MouseEvent fallback
            const executeClick = (targetEl) => {
                let clickable = targetEl;
                let foundClickable = false;

                for (let i = 0; i < 5; i++) {
                    if (!clickable) break;
                    const style = window.getComputedStyle(clickable);
                    if (style.cursor === 'pointer' || clickable.tagName === 'BUTTON' || clickable.onclick) {
                        foundClickable = true;
                        break;
                    }
                    if (clickable.parentElement) clickable = clickable.parentElement;
                }

                const finalTarget = foundClickable ? clickable : targetEl;
                finalTarget.click();

                try {
                    const rect = finalTarget.getBoundingClientRect();
                    const centerX = rect.left + (rect.width / 2);
                    const centerY = rect.top + (rect.height / 2);
                    const events = ['mousedown', 'mouseup', 'click'];
                    events.forEach(type => {
                        finalTarget.dispatchEvent(new MouseEvent(type, {
                            view: window,
                            bubbles: true,
                            cancelable: true,
                            clientX: centerX,
                            clientY: centerY,
                            button: 0
                        }));
                    });
                } catch (e) {
                    log('MouseEvent fallback failed: ' + e.message);
                }
            };

            executeClick(candidates[0].el);
            log('Executed click on candidate 0');

            // 5. Verify/retry if panel still open
            await new Promise(r => setTimeout(r, 1500));
            const isPanelStillOpen = panel.offsetParent !== null && panel.style.display !== 'none' && panel.getBoundingClientRect().height > 0;

            if (isPanelStillOpen && candidates.length > 1) {
                log('Panel still open, retrying with candidate 1: "' + candidates[1].text + '"');
                executeClick(candidates[1].el);
                await new Promise(r => setTimeout(r, 1000));
            }

            // Ensure panel closes
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', bubbles: true }));

            return { success: true, method: 'heuristic_click', bestMatch: candidates[0].text, retried: isPanelStillOpen, debug: debugInfo };
        } catch (e) {
            return { error: 'JS Exception: ' + e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Close History Panel (Escape)
async function closeHistory(cdp) {
    const EXP = `(async () => {
        try {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
            document.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Escape', code: 'Escape', bubbles: true }));
            return { success: true };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Failed to close history panel' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
    const hasMessages = chatContainer && chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0;
    return {
        hasChat: !!chatContainer,
        hasMessages: hasMessages,
        editorFound: !!(chatContainer && chatContainer.querySelector('[data-lexical-editor="true"]'))
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for leaf text nodes containing a known model keyword
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes2 = allEls.filter(el => el.children.length === 0 && el.innerText);
        
        // First try: find inside a clickable parent (button, cursor:pointer)
        let modelEl = textNodes2.find(el => {
            const txt = el.innerText.trim();
            if (!KNOWN_MODELS.some(k => txt.includes(k))) return false;
            // Must be in a clickable context (header/toolbar, not chat content)
            let parent = el;
            for (let i = 0; i < 8; i++) {
                if (!parent) break;
                if (parent.tagName === 'BUTTON' || window.getComputedStyle(parent).cursor === 'pointer') return true;
                parent = parent.parentElement;
            }
            return false;
        });
        
        // Fallback: any leaf node with a known model name
        if (!modelEl) {
            modelEl = textNodes2.find(el => {
                const txt = el.innerText.trim();
                return KNOWN_MODELS.some(k => txt.includes(k)) && txt.length < 60;
            });
        }

        if (modelEl) {
            state.model = modelEl.innerText.trim();
        }

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}



// Auto-resume the latest chat if none is open
async function autoResumeChat(cdp) {
    try {
        const history = await getChatHistory(cdp);
        if (history && history.chats && history.chats.length > 0) {
            const latest = history.chats[0].title;
            await selectChat(cdp, latest);
            return true;
        }
    } catch (err) {}
    return false;
}




// Create Express app
async function createServer() {
    const app = express();

    // Check for SSL certificates
    const keyPath = join(__dirname, 'certs', 'server.key');
    const certPath = join(__dirname, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });

    // Initialize Auth Token using a unique salt from environment
    const authSalt = process.env.AUTH_SALT || 'antigravity_default_salt_99';
    AUTH_TOKEN = hashString(APP_PASSWORD + authSalt);

    app.use(compression());
    app.use(express.json());

    // Use a secure session secret from .env if available
    const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';

    if (sessionSecret === 'antigravity_secret_key_1337') {
        console.warn('\n\x1b[33m%s\x1b[0m', '⚠️  SECURITY WARNING: Using default SESSION_SECRET ("antigravity_secret_key_1337").');
        console.warn('\x1b[33m%s\x1b[0m', '   Set a strong SESSION_SECRET in your .env file for production use.\n');
    }
    app.use(cookieParser(sessionSecret));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware
    app.use((req, res, next) => {
        const publicPaths = ['/login', '/login.html', '/favicon.ico'];
        if (publicPaths.includes(req.path) || req.path.startsWith('/css/')) {
            return next();
        }

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            return next();
        }

        // Magic Link / QR Code Auto-Login
        if (req.query.key === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Remove the key from the URL by redirecting to the base path
            return res.redirect('/');
        }

        const token = req.signedCookies[AUTH_COOKIE_NAME];
        if (token === AUTH_TOKEN) {
            return next();
        }

        // If it's an API request, return 401, otherwise redirect to login
        if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/snapshot') || req.path.startsWith('/send')) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });

    app.use(express.static(join(__dirname, 'public')));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });


    // --- Modern Stateless Endpoints ---

    // Get current snapshot for a specific port
    app.get('/snapshot', async (req, res) => {
        const port = req.query.port || 9000;
        const cdp = await getConnection(port);
        if (!cdp) return res.status(503).json({ error: 'CDP disconnected' });
        try {
            const snapshot = await captureSnapshot(cdp);
            res.json(snapshot);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Send a message to a specific port
    app.post('/message', async (req, res) => {
        const { message, port } = req.body;
        if (!message) return res.status(400).json({ error: 'Message required' });
        const cdp = await getConnection(port || 9000);
        if (!cdp) return res.status(503).json({ error: 'CDP disconnected' });
        try {
            const result = await sendMessage(cdp, message);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // App State (Model, Mode)
    app.get('/app-state', async (req, res) => {
        const port = req.query.port || 9000;
        const cdp = await getConnection(port);
        if (!cdp) return res.json({ mode: 'Unknown', model: 'Unknown' });
        const result = await getAppState(cdp);
        res.json(result);
    });

    // Chat History
    app.get('/chat-history', async (req, res) => {
        const port = req.query.port || 9000;
        const cdp = await getConnection(port);
        if (!cdp) return res.json({ error: 'CDP disconnected', chats: [] });
        const result = await getChatHistory(cdp);
        res.json(result);
    });

    // Select Chat
    app.post('/select-chat', async (req, res) => {
        const { title, port } = req.body;
        const cdp = await getConnection(port || 9000);
        if (!cdp) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await selectChat(cdp, title);
        res.json(result);
    });

    // New Chat
    app.post('/new-chat', async (req, res) => {
        const { port } = req.body;
        const cdp = await getConnection(port || 9000);
        if (!cdp) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await startNewChat(cdp);
        res.json(result);
    });

    // Workspace API
    app.get('/api/workspaces', (req, res) => {
        res.json({ workspaces });
    });

    app.post('/api/switch-workspace', async (req, res) => {
        const { id } = req.body;
        const workspace = workspaces.find(w => w.id === id);
        if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

        const cdp = await getConnection(workspace.port, workspace.path);
        if (cdp) {
            // Auto-resume if empty
            const status = await hasChatOpen(cdp);
            if (!status.hasChat) await autoResumeChat(cdp);
            res.json({ success: true, message: `Connected to ${workspace.name}` });
        } else {
            const launchCmd = `open -n -a Antigravity --args --remote-debugging-port=${workspace.port} "${workspace.path}"`;
            exec(launchCmd, () => {});
            res.json({ success: true, isLaunching: true });
        }
    });

    // --- WebSocket ---
    wss.on('connection', (ws, req) => {
        const parsedCookies = cookie.parse(req.headers.cookie || '');
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = isLocalRequest(req);

        if (!isAuthenticated && signedToken) {
            const sessionSecret = process.env.SESSION_SECRET || 'antigravity_secret_key_1337';
            const token = cookieParser.signedCookie(signedToken, sessionSecret);
            if (token === AUTH_TOKEN) isAuthenticated = true;
        }

        if (!isAuthenticated) {
            ws.close();
            return;
        }
    });

    return { server, wss, app, hasSSL };
}

async function main() {
    try {
        const { server, wss, app, hasSSL } = await createServer();
        const localIP = getLocalIP();
        server.listen(SERVER_PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on http://${localIP}:${SERVER_PORT}`);
        });
    } catch (err) {
        console.error('💥 Fatal error:', err.message);
    }
}

main();

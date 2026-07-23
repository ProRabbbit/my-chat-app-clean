import { Hono } from 'hono';
import webpush from 'web-push';

const app = new Hono();

// デプロイ（ビルド）された瞬間の日本時間を自動生成
const now = new Date();
const month = String(now.getMonth() + 1).padStart(2, '0');
const day = String(now.getDate()).padStart(2, '0');
const hour = String(now.getHours()).padStart(2, '0');
const min = String(now.getMinutes()).padStart(2, '0');
const BUILD_TIME_STR = `update:${month}${day}/${hour}${min}`;

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Set();
    this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.get("dummy");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.includes("/api/history")) {
      const { results } = await this.env.DB.prepare(
        "SELECT * FROM messages ORDER BY id DESC LIMIT 50"
      ).all();
      return Response.json(results.reverse());
    }

    if (path.includes("/api/subscribe") && request.method === "POST") {
      const sub = await request.json();
      await this.env.DB.prepare(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?) " +
        "ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth"
      ).bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth).run();
      return Response.json({ success: true });
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(websocket) {
    websocket.accept();
    this.sessions.add(websocket);

    websocket.addEventListener("message", async (event) => {
      const data = JSON.parse(event.data);
      const time = new Date().toLocaleTimeString('ja-JP', { 
        timeZone: 'Asia/Tokyo', 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      const messageData = { name: data.name, text: data.text, time: time };

      await this.env.DB.prepare(
        "INSERT INTO messages (name, text, time) VALUES (?, ?, ?)"
      ).bind(messageData.name, messageData.text, messageData.time).run();

      for (const socket of this.sessions) {
        socket.send(JSON.stringify(messageData));
      }

      if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return;

      webpush.setVapidDetails(
        'mailto:example@yourdomain.com',
        this.env.VAPID_PUBLIC_KEY,
        this.env.VAPID_PRIVATE_KEY
      );

      const { results: subs } = await this.env.DB.prepare("SELECT * FROM push_subscriptions").all();
      const payload = JSON.stringify({
        title: `${messageData.name} さんからのメッセージ`,
        body: messageData.text
      });

      for (const sub of subs) {
        try {
          await webpush.sendNotification({
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth }
          }, payload);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await this.env.DB.prepare(
              "DELETE FROM push_subscriptions WHERE endpoint = ?"
            ).bind(sub.endpoint).run();
          }
        }
      }
    });

    websocket.addEventListener("close", () => {
      this.sessions.delete(websocket);
    });
  }
}

// ルートアクセス時にHTMLを動的返却（ビルド時刻を自動埋め込み）
app.get("/", (c) => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chat App Lite | Cloudflare</title>
    <style>
        :root {
            --primary-color: #3b82f6;
            --bg-color: #f3f4f6;
            --chat-bg: #ffffff;
            --text-color: #1f2937;
            --my-message-bg: #dbeafe;
            --header-height: 60px;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: var(--bg-color);
            height: 100vh;
            display: flex;
            flex-direction: column;
            color: var(--text-color);
        }
        header {
            background: var(--chat-bg);
            color: var(--primary-color);
            height: var(--header-height);
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 1rem;
            border-bottom: 1px solid #e5e7eb;
            font-weight: bold;
            font-size: 1.25rem;
            position: fixed;
            top: 0;
            width: 100%;
            z-index: 100;
        }
        .header-title { display: flex; align-items: baseline; gap: 10px; }
        .header-title span.deploy-badge {
            font-size: 0.75rem; color: #6b7280; font-weight: normal; background: #e5e7eb; padding: 2px 6px; border-radius: 4px;
        }
        .header-right { display: flex; flex-direction: column; align-items: flex-end; font-size: 0.8rem; color: #6b7280; font-weight: normal; }
        #name-modal {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.5); display: flex; align-items: center; justify-content: center; z-index: 1000;
        }
        .modal-content {
            background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 90%; max-width: 400px; text-align: center;
        }
        .modal-content h2 { margin-bottom: 1rem; color: var(--text-color); }
        .modal-content input {
            width: 100%; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; margin-bottom: 1rem; font-size: 1rem; outline: none;
        }
        .modal-content button { width: 100%; padding: 0.75rem; }
        #chat-container {
            flex: 1; margin-top: var(--header-height); margin-bottom: 80px; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 10px;
        }
        .message { max-width: 80%; display: flex; flex-direction: column; align-items: flex-start; }
        .message.mine { align-self: flex-end; align-items: flex-end; }
        .message-info { font-size: 0.75rem; color: #6b7280; margin-bottom: 2px; }
        .message-bubble {
            background: var(--chat-bg); padding: 0.75rem 1rem; border-radius: 1rem; border-top-left-radius: 0; box-shadow: 0 1px 2px rgba(0,0,0,0.05); word-wrap: break-word;
        }
        .message.mine .message-bubble { background: var(--my-message-bg); border-top-left-radius: 1rem; border-top-right-radius: 0; }
        #input-area {
            background: var(--chat-bg); padding: 1rem; border-top: 1px solid #e5e7eb; display: flex; gap: 10px; position: fixed; bottom: 0; width: 100%;
        }
        input[type="text"] {
            flex: 1; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 1rem;
        }
        button {
            background-color: var(--primary-color); color: white; border: none; padding: 0 1.5rem; border-radius: 0.5rem; font-weight: bold; cursor: pointer; font-size: 1rem;
        }
        #chat-container::-webkit-scrollbar { width: 6px; }
        #chat-container::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 3px; }
    </style>
</head>
<body>
    <div id="name-modal">
        <div class="modal-content">
            <h2>チャットに参加</h2>
            <input type="text" id="username-input" placeholder="ユーザー名を入力..." autocomplete="off">
            <button onclick="startChat()">参加する</button>
        </div>
    </div>
    <header>
        <div class="header-title">
            Chat App Lite
            <span class="deploy-badge" id="deploy-time">${BUILD_TIME_STR}</span>
        </div>
        <div class="header-right">
            <span id="my-name"></span>
            <span id="last-updated">最終更新: --:--:--</span>
        </div>
    </header>
    <div id="chat-container">
        <div style="text-align:right; padding-bottom: 4px;">
            <button id="refresh-btn" onclick="loadHistory()" style="padding: 5px 10px; font-size: 0.8rem;">更新</button>
        </div>
    </div>
    <div id="input-area">
        <input type="text" id="message-input" placeholder="メッセージを入力..." autocomplete="off">
        <button onclick="sendMessage()">送信</button>
    </div>
    <script>
        const PUBLIC_VAPID_KEY = 'BK1Eckw9QBp5VYWdIi32LhYNg2xQECo2cQcwVlZaZ8ZJ2iBUfaJ_I-qBt0s2SlTZpbC5f0PgBeGd022usJMKROA';
        let myName = "";
        const chatContainer = document.getElementById("chat-container");
        const input = document.getElementById("message-input");
        const usernameInput = document.getElementById("username-input");
        const nameModal = document.getElementById("name-modal");

        function updateLastTime() {
            const now = new Date();
            const timeString = now.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
            document.getElementById("last-updated").innerText = "最終更新: " + timeString;
        }

        async function startChat() {
            const name = usernameInput.value.trim();
            if (!name) { alert("ユーザー名を入力してください！"); return; }
            myName = name;
            document.getElementById("my-name").innerText = "名前: " + myName;
            nameModal.style.display = "none";

            if ("Notification" in window) {
                await Notification.requestPermission();
            }

            if ('serviceWorker' in navigator && 'PushManager' in window) {
                try {
                    const reg = await navigator.serviceWorker.register('/sw.js');
                    const existing = await reg.pushManager.getSubscription();
                    if (existing) await existing.unsubscribe();

                    const subscription = await reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
                    });

                    await fetch('/api/subscribe', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(subscription)
                    });
                } catch (e) {
                    console.error("Push subscription failed:", e);
                }
            }
            loadHistory();
            connectWebSocket();
        }

        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        usernameInput.addEventListener("keypress", (e) => { if (e.key === 'Enter') startChat(); });

        async function loadHistory() {
            try {
                const messages = await fetch('/api/history').then(r => r.json());
                document.querySelectorAll('.message').forEach(el => el.remove());
                messages.forEach(appendMessage);
                updateLastTime();
            } catch (e) { console.error(e); }
        }

        let ws;
        function connectWebSocket() {
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            ws = new WebSocket(protocol + "//" + window.location.host + "/api/room/default-room");
            ws.onmessage = (event) => {
                appendMessage(JSON.parse(event.data));
                updateLastTime();
            };
            ws.onclose = () => setTimeout(connectWebSocket, 3000);
        }

        function appendMessage(data) {
            const isMine = data.name === myName;
            const div = document.createElement("div");
            div.className = "message " + (isMine ? 'mine' : '');
            div.innerHTML = \`<div class="message-info"><span class="name">\${escapeHtml(data.name)}</span> ・ \${data.time || ''}</div><div class="message-bubble">\${escapeHtml(data.text)}</div>\`;
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function sendMessage() {
            const text = input.value;
            if (!text.trim() || !ws) return;
            ws.send(JSON.stringify({ name: myName, text: text }));
            input.value = "";
            input.focus();
        }

        input.addEventListener("keypress", (e) => { if (e.key === 'Enter') sendMessage(); });

        function escapeHtml(str) {
            if (!str) return "";
            return str.replace(/[&'\`<>"]/g, (m) => ({ '&': '&amp;', "'": '&#x27;', '\`': '&#x60;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
        }
    </script>
</body>
</html>`;
  return c.html(html);
});

app.get("/api/history", async (c) => {
  const id = c.env.CHAT_ROOM.idFromName("default-room");
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.post("/api/subscribe", async (c) => {
  const id = c.env.CHAT_ROOM.idFromName("default-room");
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.get("/api/room/:id", async (c) => {
  const idParam = c.req.param("id");
  const id = c.env.CHAT_ROOM.idFromName(idParam);
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
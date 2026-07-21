import { Hono } from 'hono';

const app = new Hono();

// --- バックエンド (Durable Object) ---
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

    // 過去の履歴を返すAPI
    if (url.pathname === "/api/history") {
      const { results } = await this.env.DB.prepare(
        "SELECT * FROM messages ORDER BY id DESC LIMIT 50"
      ).all();
      // 古い順に並べ替えて返す
      return Response.json(results.reverse());
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
      const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
      const messageData = { name: data.name, text: data.text, time: time };

      // データベースにメッセージを保存
      await this.env.DB.prepare(
        "INSERT INTO messages (name, text, time) VALUES (?, ?, ?)"
      ).bind(messageData.name, messageData.text, messageData.time).run();

      // 接続中の全員にブロードキャスト
      for (const socket of this.sessions) {
        socket.send(JSON.stringify(messageData));
      }
    });

    websocket.addEventListener("close", () => {
      this.sessions.delete(websocket);
    });
  }
}

// --- フロントエンド (HTML/CSS) ---
const htmlContent = `<!DOCTYPE html>
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
        header span { font-size: 0.875rem; color: #6b7280; font-weight: normal; }
        #chat-container {
            flex: 1;
            margin-top: var(--header-height);
            margin-bottom: 80px;
            overflow-y: auto;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }
        .message { max-width: 80%; display: flex; flex-direction: column; align-items: flex-start; }
        .message.mine { align-self: flex-end; align-items: flex-end; }
        .message-info { font-size: 0.75rem; color: #6b7280; margin-bottom: 2px; }
        .message-bubble {
            background: var(--chat-bg);
            padding: 0.75rem 1rem;
            border-radius: 1rem;
            border-top-left-radius: 0;
            box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            word-wrap: break-word;
        }
        .message.mine .message-bubble {
            background: var(--my-message-bg);
            border-top-left-radius: 1rem;
            border-top-right-radius: 0;
        }
        #input-area {
            background: var(--chat-bg);
            padding: 1rem;
            border-top: 1px solid #e5e7eb;
            display: flex;
            gap: 10px;
            position: fixed;
            bottom: 0;
            width: 100%;
        }
        input[type="text"] {
            flex: 1; padding: 0.75rem; border: 1px solid #d1d5db; border-radius: 0.5rem; outline: none; font-size: 1rem;
        }
        input[type="text"]:focus { border-color: var(--primary-color); }
        button {
            background-color: var(--primary-color); color: white; border: none; padding: 0 1.5rem; border-radius: 0.5rem; font-weight: bold; cursor: pointer; font-size: 1rem;
        }
        button:hover { background-color: #2563eb; }
        #chat-container::-webkit-scrollbar { width: 6px; }
        #chat-container::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 3px; }
    </style>
</head>
<body>
    <header>
        Chat App Lite
        <span id="my-name"></span>
    </header>
    <div id="chat-container"></div>
    <div id="input-area">
        <input type="text" id="message-input" placeholder="メッセージを入力..." autocomplete="off">
        <button onclick="sendMessage()">送信</button>
    </div>

    <script>
        const randomName = "ゲスト" + Math.floor(Math.random() * 9000 + 1000);
        document.getElementById("my-name").innerText = "あなたの名前: " + randomName;

        const chatContainer = document.getElementById("chat-container");
        const input = document.getElementById("message-input");

        // 1. ページを開いたときに過去の履歴を読み込む
        async function loadHistory() {
            try {
                const res = await fetch('/api/history');
                const history = await res.json();
                history.forEach(data => appendMessage(data));
            } catch (e) {
                console.error("履歴の取得に失敗しました", e);
            }
        }
        loadHistory();

        // 2. WebSocketの接続
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}/api/room/default-room\`);

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            appendMessage(data);
        };

        function appendMessage(data) {
            const isMine = data.name === randomName;
            const div = document.createElement("div");
            div.className = \`message \${isMine ? 'mine' : ''}\`;

            div.innerHTML = \`
                <div class="message-info">
                    <span class="name">\${escapeHtml(data.name)}</span> ・ \${data.time || ''}
                </div>
                <div class="message-bubble">\${escapeHtml(data.text)}</div>
            \`;
            chatContainer.appendChild(div);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function sendMessage() {
            const text = input.value;
            if (!text.trim()) return;

            const payload = {
                name: randomName,
                text: text
            };
            ws.send(JSON.stringify(payload));
            input.value = "";
            input.focus();
        }

        input.addEventListener("keypress", function (e) {
            if (e.key === 'Enter') sendMessage();
        });

        function escapeHtml(str) {
            if (!str) return "";
            return str.replace(/[&'\`<>"]/g, (match) => ({
                '&': '&amp;', "'": '&#x27;', '\`': '&#x60;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
            }[match]));
        }
    </script>
</body>
</html>`;

app.get("/", (c) => c.html(htmlContent));

// 履歴取得APIをDurable Object側にルーティング
app.get("/api/history", async (c) => {
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
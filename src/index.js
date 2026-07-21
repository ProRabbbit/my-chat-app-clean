import { Hono } from 'hono';

const app = new Hono();

// --- バックエンド (Durable Object) ---
// 変更なし
export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Set();
    // ストレージの自動初期化（エラー対策）
    this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.get("dummy");
    });
  }

  async fetch(request) {
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
      for (const socket of this.sessions) {
        socket.send(event.data);
      }
    });
    websocket.addEventListener("close", () => {
      this.sessions.delete(websocket);
    });
  }
}

// --- フロントエンド (HTML/CSS) ---
// デザインを現代風に刷新しました
const htmlContent = `<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Chat App Lite | Cloudflare</title>
    <style>
        :root {
            --primary-color: #3b82f6; /* 青色 */
            --bg-color: #f3f4f6; /* 薄いグレー */
            --chat-bg: #ffffff;
            --text-color: #1f2937;
            --my-message-bg: #dbeafe;
            --header-height: 60px;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            height: 100vh;
            display: flex;
            flex-direction: direction;
            color: var(--text-color);
        }

        /* ヘッダー */
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

        header span {
            font-size: 0.875rem;
            color: #6b7280;
            font-weight: normal;
        }

        /* チャットエリア */
        #chat-container {
            flex: 1;
            margin-top: var(--header-height);
            margin-bottom: 80px; /* 入力エリアのスペース */
            overflow-y: auto;
            padding: 1rem;
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .message {
            max-width: 80%;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
        }

        .message.mine {
            align-self: flex-end;
            align-items: flex-end;
        }

        .message-info {
            font-size: 0.75rem;
            color: #6b7280;
            margin-bottom: 2px;
        }

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

        /* 入力エリア */
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
            flex: 1;
            padding: 0.75rem;
            border: 1px solid #d1d5db;
            border-radius: 0.5rem;
            outline: none;
            font-size: 1rem;
        }

        input[type="text"]:focus {
            border-color: var(--primary-color);
        }

        button {
            background-color: var(--primary-color);
            color: white;
            border: none;
            padding: 0 1.5rem;
            border-radius: 0.5rem;
            font-weight: bold;
            cursor: pointer;
            font-size: 1rem;
            transition: background-color 0.2s;
        }

        button:hover {
            background-color: #2563eb;
        }

        /* スクロールバーの調整 */
        #chat-container::-webkit-scrollbar { width: 6px; }
        #chat-container::-webkit-scrollbar-thumb { background-color: #cbd5e1; border-radius: 3px; }
    </style>
</head>
<body>

    <header>
        Chat App Lite
        <span id="my-name"></span>
    </header>

    <div id="chat-container">
        <!-- メッセージがここに挿入されます -->
    </div>

    <div id="input-area">
        <input type="text" id="message-input" placeholder="メッセージを入力..." autocomplete="off">
        <button onclick="sendMessage()">送信</button>
    </div>

    <script>
        // 名前の自動生成
        const randomName = "ゲスト" + Math.floor(Math.random() * 9000 + 1000);
        document.getElementById("my-name").innerText = "あなたの名前: " + randomName;

        // WebSocket接続
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(\`\${protocol}//\${window.location.host}/api/room/default-room\`);

        const chatContainer = document.getElementById("chat-container");
        const input = document.getElementById("message-input");

        // エンターキーでも送信できるようにする
        input.addEventListener("keypress", function (e) {
            if (e.key === 'Enter') sendMessage();
        });

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            appendMessage(data);
        };

        function appendMessage(data) {
            const isMine = data.name === randomName;
            const div = document.createElement("div");
            div.className = \`message \${isMine ? 'mine' : ''}\`;

            const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });

            div.innerHTML = \`
                <div class="message-info">
                    <span class="name">\${escapeHtml(data.name)}</span> ・ \${time}
                </div>
                <div class="message-bubble">\${escapeHtml(data.text)}</div>
            \`;

            chatContainer.appendChild(div);
            // 自動で一番下までスクロール
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
            input.focus(); // 入力欄にフォーカスを戻す
        }

        function escapeHtml(str) {
            if (!str) return "";
            return str.replace(/[&'\`<>"]/g, (match) => ({
                '&': '&amp;', "'": '&#x27;', '\`': '&#x60;', '<': '&lt;', '>': '&gt;', '"': '&quot;'
            }[match]));
        }
    </script>
</body>
</html>`;

// --- ルーティング ---
app.get("/", (c) => c.html(htmlContent));

app.get("/api/room/:id", async (c) => {
  const idParam = c.req.param("id");
  // 固定のルームIDを使用
  const id = c.env.CHAT_ROOM.idFromName(idParam);
  const stub = c.env.CHAT_ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export default app;
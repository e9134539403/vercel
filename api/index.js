// 1. Файл api/index.js - минимальная обертка
const HEYGEN_API_KEY = process.env.HEYGEN_API_KEY;

module.exports = async (req, res) => {
  // Обработка CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // API для токена
  if (req.url === '/api/get-access-token' && req.method === 'POST') {
    if (!HEYGEN_API_KEY) {
      return res.status(500).send("API key is missing");
    }
    
    try {
      const response = await fetch('https://api.heygen.com/v1/streaming.create_token', {
        method: "POST",
        headers: {
          "x-api-key": HEYGEN_API_KEY,
        },
      });
      
      const data = await response.json();
      return res.status(200).send(data.data.token);
    } catch (error) {
      return res.status(500).send("Failed to retrieve access token");
    }
  }
  
  // Главная страница - редирект на ваш GitHub Pages или простой HTML
  if (req.url === '/' && req.method === 'GET') {
    return res.status(200).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>HeyGen Avatar</title>
        <meta charset="utf-8">
        <style>
          body { 
            margin: 0; 
            background: #000; 
            color: white;
            font-family: system-ui;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
          }
          .container {
            text-align: center;
          }
          button {
            background: #7559FF;
            color: white;
            border: none;
            padding: 15px 30px;
            font-size: 18px;
            border-radius: 8px;
            cursor: pointer;
            margin: 10px;
          }
          button:hover {
            background: #5a3ecc;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>HeyGen Interactive Avatar</h1>
          <p>API endpoint is ready at: /api/get-access-token</p>
          <button onclick="testAPI()">Test API</button>
          <div id="result"></div>
        </div>
        <script>
          async function testAPI() {
            try {
              const response = await fetch('/api/get-access-token', {
                method: 'POST'
              });
              const token = await response.text();
              document.getElementById('result').innerHTML = 
                '<p style="color: #0f0;">✓ API Works! Token received.</p>';
              console.log('Token:', token);
            } catch (error) {
              document.getElementById('result').innerHTML = 
                '<p style="color: #f00;">✗ Error: ' + error.message + '</p>';
            }
          }
        </script>
      </body>
      </html>
    `);
  }
  
  // 404 для остальных маршрутов
  res.status(404).send('Not found');
};

// ============================================
// 2. Файл vercel.json
{
  "version": 2,
  "builds": [
    {
      "src": "api/index.js",
      "use": "@vercel/node"
    }
  ],
  "routes": [
    {
      "src": "/(.*)",
      "dest": "/api/index.js"
    }
  ]
}

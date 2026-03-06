export default {
  speaker: {
    userId: "84535025",
    password: "caonimadebi8!",
    passToken: "V1:DXmurwq2/R1BHTELu6obCUkuvGEvh+ShLeOuwSVaf+6tvyYPfjA0fBcjkhUqhaYBXZ0OGPv7g4lzDzO9/k0rfXJBYZka0STSyMRKaDZQB/44RdF7gJ/NmKFyJ7T2CHEFXchchpQMcbwCEZXHMNyGYe8skSovBmc9toYa0p/xUlojC9khSoIdbRKWtj24oveoGwruUknLv02rerljSIN/CPRGCvo9ZRYLvsiS6mefsBwhOwTuoMHpeF2z4n9XAo8prcd3ovSyf3802YuP6hGxfY+sEBi2utnXJ0Z09hKefOKgn+HwK1AX1sB/UlvfTFp3BOffaj2dYXMbK/RC05b81A==",
    did: "小爱音箱Pro",
  },
  openai: {
    model: "deepseek-chat",              // 或 deepseek-reasoner
    baseURL: "https://api.deepseek.com", // 也可写 https://api.deepseek.com/v1
    apiKey: "sk-7c8028ca49ed466ca307bcbc9411be7b",
  },
  async onMessage(engine, msg) {
    console.log("收到消息：", msg.text);
    if (msg.text.includes("测试")) {
      return { text: "测试成功！我已经接入 DeepSeek 了～" };
    }
  },
};

echo 'ws://192.168.2.1:4399' > /data/open-xiaoai/server.txt
cat /data/open-xiaoai/server.txt
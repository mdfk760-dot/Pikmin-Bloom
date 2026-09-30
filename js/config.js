const CONFIG = {
  API_URL: "https://script.google.com/macros/s/AKfycby6rxbH_2xObY8yeCMD3bzspAqwMEIrHhWRfA5OrGHdLx55DPeUKTENqd7DkoAEjn7p/exec",

  // 公開資料透過 Cloudflare Worker 讀取
  PUBLIC_API_URL:
    "https://yaoyao-pikmin-api.liuhomesally.workers.dev",

  SITE_UPDATE_CHECK_INTERVAL: 60 * 1000,
  FRONTEND_CACHE_MAX_AGE: 15 * 60 * 1000,
  DATA_VERSION_CHECK_INTERVAL: 15 * 1000, // 每 15 秒只問 Apps Script：現在的公告版本是多少？
  FRUIT_AVAILABLE_MINUTES: 60
};


const COLORS = [
  "混色",
  "黃色",
  "紅色",
  "藍色",
  "白色"
];

const FLOWERS = [
  "雜田",
  "三色堇",
  "玫瑰",
  "聖誕紅",
  "山茶花",
  "梅花",
  "櫻花",
  "鬱金香",
  "康乃馨",
  "繡球花",
  "百合",
  "向日葵",
  "彼岸花",
  "大波斯菊",
  "兔耳花",
  "水仙花",
  "銀蓮花",
  "粉蝶花",
  "海芋",
  "雞蛋花",
  "扶桑花",
  "石竹",
  "龍膽",
  "菊花",
  "聖誕玫瑰",
  "嘉德麗雅蘭",
  "風信子",
  "豌豆花",
  "鈴蘭",
  "牡丹",
  "睡蓮",
  "牽牛花",
  "九重葛",
  "大理花",
  "鐵線蓮",
  "雪花蓮",
  "小蒼蘭",
  "油菜花",
  "週年玫瑰",
  "鳶尾花",
  "天堂鳥",
  "雞冠花",
  "萬壽菊",
  "鼠尾草",
  "櫻草花",
  "蝴蝶蘭",
  "金魚草",
  "矮牽牛",
  "鸚鵡鬱金香",
  "勿忘草",
  "風鈴草",
  "曇花",
  "美人蕉",
  "洋桔梗",
  "薊花"
];

// A built-in gazetteer of the world's main steel ports, so the map needs no
// geocoding service: place names never leave the server. A place that matches
// nothing here is simply not drawn; it still shows in the list.
// Coordinates are approximate port locations [longitude, latitude]. Aliases are
// lower case and matched as substrings, so short or common words (Mobile,
// Victoria, San Antonio) are only listed with a qualifier.

export interface Place {
  name: string;
  lonlat: [number, number];
}

const PORTS: { name: string; lonlat: [number, number]; aliases: string[] }[] = [
  // East and Southeast Asia
  { name: "Haiphong", lonlat: [106.68, 20.86], aliases: ["haiphong", "hai phong", "海防"] },
  { name: "Ho Chi Minh City", lonlat: [106.7, 10.77], aliases: ["ho chi minh", "hcmc", "saigon", "胡志明"] },
  { name: "Da Nang", lonlat: [108.22, 16.07], aliases: ["da nang", "danang", "岘港"] },
  { name: "Busan", lonlat: [129.04, 35.1], aliases: ["busan", "pusan", "釜山", "부산"] },
  { name: "Incheon", lonlat: [126.62, 37.45], aliases: ["incheon", "仁川", "인천"] },
  { name: "Ulsan", lonlat: [129.38, 35.5], aliases: ["ulsan", "蔚山", "울산"] },
  { name: "Gwangyang", lonlat: [127.7, 34.9], aliases: ["gwangyang", "光阳", "광양"] },
  { name: "Tianjin", lonlat: [117.75, 38.97], aliases: ["tianjin", "xingang", "天津"] },
  { name: "Tangshan", lonlat: [118.5, 39.2], aliases: ["tangshan", "caofeidian", "jingtang", "唐山", "曹妃甸", "京唐"] },
  { name: "Dalian", lonlat: [121.65, 38.92], aliases: ["dalian", "大连"] },
  { name: "Qingdao", lonlat: [120.32, 36.07], aliases: ["qingdao", "青岛"] },
  { name: "Rizhao", lonlat: [119.53, 35.38], aliases: ["rizhao", "日照"] },
  { name: "Lianyungang", lonlat: [119.45, 34.75], aliases: ["lianyungang", "连云港"] },
  { name: "Shanghai", lonlat: [121.49, 31.23], aliases: ["shanghai", "上海"] },
  { name: "Ningbo", lonlat: [121.85, 29.93], aliases: ["ningbo", "宁波"] },
  { name: "Xiamen", lonlat: [118.07, 24.48], aliases: ["xiamen", "厦门"] },
  { name: "Guangzhou", lonlat: [113.26, 23.13], aliases: ["guangzhou", "广州"] },
  { name: "Shenzhen", lonlat: [114.06, 22.54], aliases: ["shenzhen", "深圳"] },
  { name: "Hong Kong", lonlat: [114.17, 22.3], aliases: ["hong kong", "香港"] },
  { name: "Kaohsiung", lonlat: [120.28, 22.61], aliases: ["kaohsiung", "高雄"] },
  { name: "Taichung", lonlat: [120.52, 24.27], aliases: ["taichung", "台中"] },
  { name: "Keelung", lonlat: [121.74, 25.13], aliases: ["keelung", "基隆"] },
  { name: "Yokohama", lonlat: [139.64, 35.44], aliases: ["yokohama", "横浜", "横滨"] },
  { name: "Tokyo", lonlat: [139.79, 35.62], aliases: ["tokyo", "東京", "东京"] },
  { name: "Nagoya", lonlat: [136.88, 35.08], aliases: ["nagoya", "名古屋"] },
  { name: "Osaka", lonlat: [135.43, 34.65], aliases: ["osaka", "大阪"] },
  { name: "Kobe", lonlat: [135.19, 34.68], aliases: ["kobe", "神戸", "神户"] },
  { name: "Manila", lonlat: [120.96, 14.6], aliases: ["manila", "马尼拉"] },
  { name: "Bangkok", lonlat: [100.57, 13.7], aliases: ["bangkok", "曼谷"] },
  { name: "Laem Chabang", lonlat: [100.88, 13.08], aliases: ["laem chabang", "林查班"] },
  { name: "Port Klang", lonlat: [101.39, 3.0], aliases: ["port klang", "klang", "巴生"] },
  { name: "Singapore", lonlat: [103.84, 1.26], aliases: ["singapore", "新加坡"] },
  { name: "Jakarta", lonlat: [106.88, -6.1], aliases: ["jakarta", "tanjung priok", "雅加达"] },
  { name: "Surabaya", lonlat: [112.73, -7.2], aliases: ["surabaya", "泗水"] },
  // South Asia and the Middle East
  { name: "Chittagong", lonlat: [91.8, 22.31], aliases: ["chittagong", "chattogram", "吉大港"] },
  { name: "Colombo", lonlat: [79.85, 6.95], aliases: ["colombo", "科伦坡"] },
  { name: "Chennai", lonlat: [80.3, 13.1], aliases: ["chennai", "madras", "金奈"] },
  { name: "Visakhapatnam", lonlat: [83.29, 17.69], aliases: ["visakhapatnam", "vizag"] },
  { name: "Mumbai", lonlat: [72.95, 18.95], aliases: ["mumbai", "nhava sheva", "jnpt", "孟买"] },
  { name: "Mundra", lonlat: [69.7, 22.74], aliases: ["mundra"] },
  { name: "Karachi", lonlat: [66.98, 24.84], aliases: ["karachi", "卡拉奇"] },
  { name: "Jebel Ali", lonlat: [55.06, 25.01], aliases: ["jebel ali", "dubai", "迪拜"] },
  { name: "Dammam", lonlat: [50.2, 26.5], aliases: ["dammam", "达曼"] },
  { name: "Iskenderun", lonlat: [36.17, 36.59], aliases: ["iskenderun", "伊斯肯德伦"] },
  { name: "Izmit", lonlat: [29.9, 40.76], aliases: ["izmit", "kocaeli", "gebze"] },
  { name: "Istanbul", lonlat: [28.98, 41.0], aliases: ["istanbul", "伊斯坦布尔"] },
  // Europe
  { name: "Rotterdam", lonlat: [4.14, 51.95], aliases: ["rotterdam", "鹿特丹"] },
  { name: "Antwerp", lonlat: [4.4, 51.26], aliases: ["antwerp", "antwerpen", "anvers", "安特卫普"] },
  { name: "Amsterdam", lonlat: [4.82, 52.41], aliases: ["amsterdam", "阿姆斯特丹"] },
  { name: "Hamburg", lonlat: [9.97, 53.54], aliases: ["hamburg", "汉堡"] },
  { name: "Bremerhaven", lonlat: [8.58, 53.55], aliases: ["bremerhaven", "bremen", "不来梅"] },
  { name: "Gdańsk", lonlat: [18.66, 54.4], aliases: ["gdansk", "gdańsk", "格但斯克"] },
  { name: "Le Havre", lonlat: [0.11, 49.48], aliases: ["le havre", "勒阿弗尔"] },
  { name: "Bilbao", lonlat: [-3.05, 43.35], aliases: ["bilbao", "毕尔巴鄂"] },
  { name: "Valencia", lonlat: [-0.32, 39.44], aliases: ["valencia, spain", "port of valencia", "瓦伦西亚"] },
  { name: "Barcelona", lonlat: [2.16, 41.35], aliases: ["barcelona", "巴塞罗那"] },
  { name: "Marseille-Fos", lonlat: [4.87, 43.42], aliases: ["marseille", "fos-sur-mer", "马赛"] },
  { name: "Genoa", lonlat: [8.9, 44.4], aliases: ["genoa", "genova", "热那亚"] },
  { name: "Ravenna", lonlat: [12.27, 44.49], aliases: ["ravenna", "拉文纳"] },
  // Africa
  { name: "Alexandria", lonlat: [29.87, 31.18], aliases: ["alexandria, egypt", "port of alexandria", "亚历山大港"] },
  { name: "Lagos", lonlat: [3.38, 6.44], aliases: ["lagos", "apapa", "tin can island", "拉各斯"] },
  { name: "Mombasa", lonlat: [39.66, -4.06], aliases: ["mombasa", "蒙巴萨"] },
  { name: "Durban", lonlat: [31.03, -29.87], aliases: ["durban", "德班"] },
  // Oceania
  { name: "Brisbane", lonlat: [153.17, -27.38], aliases: ["brisbane", "布里斯班"] },
  { name: "Sydney", lonlat: [151.21, -33.97], aliases: ["sydney", "port botany", "悉尼"] },
  { name: "Melbourne", lonlat: [144.92, -37.84], aliases: ["melbourne", "墨尔本"] },
  { name: "Auckland", lonlat: [174.78, -36.84], aliases: ["auckland", "奥克兰"] },
  // North America
  { name: "Vancouver", lonlat: [-123.1, 49.29], aliases: ["vancouver", "温哥华"] },
  { name: "Seattle", lonlat: [-122.35, 47.6], aliases: ["seattle", "tacoma", "西雅图"] },
  { name: "Portland", lonlat: [-122.75, 45.6], aliases: ["portland, or", "portland, oregon", "port of portland"] },
  { name: "Oakland", lonlat: [-122.3, 37.8], aliases: ["oakland"] },
  { name: "Los Angeles", lonlat: [-118.26, 33.74], aliases: ["los angeles", "洛杉矶"] },
  { name: "Long Beach", lonlat: [-118.21, 33.75], aliases: ["long beach", "长滩"] },
  { name: "Houston", lonlat: [-95.02, 29.73], aliases: ["houston", "休斯顿", "休斯敦"] },
  { name: "Corpus Christi", lonlat: [-97.4, 27.81], aliases: ["corpus christi"] },
  { name: "New Orleans", lonlat: [-90.06, 29.94], aliases: ["new orleans", "nueva orleans", "新奥尔良"] },
  { name: "Mobile", lonlat: [-88.04, 30.69], aliases: ["mobile, al", "mobile, alabama", "port of mobile"] },
  { name: "Tampa", lonlat: [-82.44, 27.94], aliases: ["tampa", "坦帕"] },
  { name: "Savannah", lonlat: [-81.14, 32.08], aliases: ["savannah", "萨凡纳"] },
  { name: "Charleston", lonlat: [-79.92, 32.79], aliases: ["charleston", "查尔斯顿"] },
  { name: "Baltimore", lonlat: [-76.56, 39.25], aliases: ["baltimore", "巴尔的摩"] },
  { name: "Philadelphia", lonlat: [-75.14, 39.92], aliases: ["philadelphia", "费城"] },
  { name: "New York / New Jersey", lonlat: [-74.15, 40.68], aliases: ["new york", "new jersey", "newark", "elizabeth, nj", "纽约", "纽瓦克"] },
  { name: "Chicago", lonlat: [-87.55, 41.7], aliases: ["chicago", "burns harbor", "芝加哥"] },
  { name: "Detroit", lonlat: [-83.05, 42.32], aliases: ["detroit", "底特律"] },
  { name: "Cleveland", lonlat: [-81.7, 41.5], aliases: ["cleveland", "克利夫兰"] },
  { name: "Hamilton", lonlat: [-79.85, 43.28], aliases: ["hamilton, on", "hamilton, ontario", "port of hamilton"] },
  { name: "Montreal", lonlat: [-73.55, 45.5], aliases: ["montreal", "montréal", "蒙特利尔"] },
  { name: "Altamira", lonlat: [-97.87, 22.48], aliases: ["altamira", "tampico", "阿尔塔米拉"] },
  { name: "Veracruz", lonlat: [-96.13, 19.2], aliases: ["veracruz", "韦拉克鲁斯"] },
  { name: "Lázaro Cárdenas", lonlat: [-102.18, 17.94], aliases: ["lazaro cardenas", "lázaro cárdenas"] },
  { name: "Manzanillo", lonlat: [-104.31, 19.05], aliases: ["manzanillo", "曼萨尼约"] },
  // South America
  { name: "Callao", lonlat: [-77.15, -12.05], aliases: ["callao", "卡亚俄"] },
  { name: "San Antonio", lonlat: [-71.62, -33.59], aliases: ["san antonio, chile", "puerto san antonio"] },
  { name: "Buenos Aires", lonlat: [-58.37, -34.6], aliases: ["buenos aires", "布宜诺斯艾利斯"] },
  { name: "Santos", lonlat: [-46.3, -23.97], aliases: ["santos", "桑托斯"] },
  { name: "Rio de Janeiro", lonlat: [-43.2, -22.89], aliases: ["rio de janeiro", "里约"] },
  { name: "Vitória", lonlat: [-40.29, -20.32], aliases: ["vitória", "vitoria, brazil", "tubarão", "tubarao"] },
];

/** The port a free-text place names, if it is one we know; the longest matching alias wins. */
export function findPlace(text: string | null | undefined): Place | null {
  if (!text) return null;
  const t = text.toLowerCase();
  let best: { name: string; lonlat: [number, number]; len: number } | null = null;
  for (const p of PORTS) {
    for (const a of p.aliases) {
      if (t.includes(a) && (!best || a.length > best.len)) best = { name: p.name, lonlat: p.lonlat, len: a.length };
    }
  }
  return best && { name: best.name, lonlat: best.lonlat };
}

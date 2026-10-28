// A small built-in gazetteer of steel ports in East and Southeast Asia, so the
// map needs no geocoding service: place names never leave the server. A place
// that matches nothing here is simply not drawn; it still shows in the list.
// Coordinates are approximate port locations [longitude, latitude].

export interface Place {
  name: string;
  lonlat: [number, number];
}

const PORTS: { name: string; lonlat: [number, number]; aliases: string[] }[] = [
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

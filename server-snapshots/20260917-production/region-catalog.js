// Minimal local visual-fixture region catalog. The production catalog is not copied
// into this read-only fixture; the route audit only needs the server to boot.
const CHINA_REGIONS = Object.freeze({
  北京市: ["北京市"],
  上海市: ["上海市"],
  广东省: ["广州市", "深圳市"],
  浙江省: ["杭州市", "宁波市"],
});

function normalizeRegionSelection(country, province, city) {
  const normalizedCountry = String(country || "中国").trim() || "中国";
  const normalizedProvince = String(province || "").trim();
  const normalizedCity = String(city || "").trim();
  if (normalizedCountry !== "中国") return { country: normalizedCountry, province: "", city: "" };
  if (normalizedProvince && !Object.hasOwn(CHINA_REGIONS, normalizedProvince)) return { country: normalizedCountry, province: "", city: "" };
  if (normalizedCity && normalizedProvince && !CHINA_REGIONS[normalizedProvince].includes(normalizedCity)) return { country: normalizedCountry, province: normalizedProvince, city: "" };
  return { country: normalizedCountry, province: normalizedProvince, city: normalizedCity };
}

module.exports = { CHINA_REGIONS, normalizeRegionSelection };

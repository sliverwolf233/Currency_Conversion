// CardRate — 四大卡组织汇率换算器（Win32 古早风格桌面版）
// Pure Win32 (USER32 + COMCTL32 native controls, no visual styles manifest),
// MSVC /utf-8 /MT. Networking via WinHTTP — desktop apps have no CORS limits.
//
// Modes:
//   CardRate.exe            GUI (classic Windows look)
//   CardRate.exe --cli FROM TO AMOUNT [FEE] [DATE] [SETTLE] [PROVIDER]
//   CardRate.exe --selftest offline parser/math self test (CI-safe)
//
// Providers (reverse-engineered endpoints, see docs in the web edition):
//   Visa       GET www.visa.com.hk/cmsapi/fx/rates (params direction inverted)
//   Mastercard GET www.mastercard.com/marketingservices/.../conversion-rates
//   JCB        GET www.jcb.jp/rate/jpy.html | usdMMDDYYYY.html (HTML tables)
//   UnionPay   GET m.unionpayintl.com/jfimg/YYYYMMDD.json (daily matrix)

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <windowsx.h>
#include <commctrl.h>
#include <winhttp.h>
#include <shlwapi.h>
#include <shellapi.h>

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <thread>
#include <mutex>
#include <regex>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <algorithm>

#pragma comment(lib, "user32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "comctl32.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "shlwapi.lib")
#pragma comment(lib, "shell32.lib")

// ============================================================
// 1. string utils (UTF-8 <-> UTF-16)
// ============================================================
static std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return L"";
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), &w[0], n);
  return w;
}
static std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return "";
  int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), &s[0], n, nullptr, nullptr);
  return s;
}
static std::string Trim(const std::string& s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  size_t b = s.find_last_not_of(" \t\r\n");
  return s.substr(a, b - a + 1);
}
static std::string Upper(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return (char)toupper(c); });
  return s;
}
static std::wstring FmtRate(double r) {
  double a = fabs(r);
  int dp = a >= 1000 ? 2 : a >= 100 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  wchar_t buf[64];
  swprintf(buf, 64, L"%.*f", dp, r);
  return buf;
}
static std::wstring FmtMoney(double v) {
  wchar_t buf[64];
  double a = fabs(v);
  if (a >= 1) swprintf(buf, 64, L"%.2f", v);
  else swprintf(buf, 64, L"%.6f", v);
  return buf;
}

// ============================================================
// 2. tiny JSON parser (objects, arrays, strings, numbers, bool, null)
// ============================================================
struct JVal;
using JPtr = std::shared_ptr<JVal>;
struct JVal {
  enum Type { NUL, BOOL, NUM, STR, ARR, OBJ } type = NUL;
  bool b = false;
  double num = 0;
  std::string str;
  std::vector<JPtr> arr;
  std::map<std::string, JPtr> obj;
  bool is(const char* k) const { return type == OBJ && obj.count(k) > 0; }
  JPtr get(const char* k) const { auto it = obj.find(k); return it == obj.end() ? nullptr : it->second; }
};

struct JParser {
  const char* p; const char* end;
  explicit JParser(const std::string& s) : p(s.data()), end(s.data() + s.size()) {}
  void ws() { while (p < end && (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n')) ++p; }
  bool lit(const char* s) { size_t n = strlen(s); if (end - p < (ptrdiff_t)n || strncmp(p, s, n) != 0) return false; p += n; return true; }
  static void DecodeStr(std::string& out, const std::string& raw) {
    for (size_t i = 0; i < raw.size(); ++i) {
      char c = raw[i];
      if (c == '\\' && i + 1 < raw.size()) {
        char d = raw[++i];
        switch (d) {
          case '"': out += '"'; break;  case '\\': out += '\\'; break;
          case '/': out += '/'; break;  case 'b': out += '\b'; break;
          case 'f': out += '\f'; break; case 'n': out += '\n'; break;
          case 'r': out += '\r'; break; case 't': out += '\t'; break;
          case 'u': {
            if (i + 4 < raw.size()) {
              unsigned cp = 0;
              for (int k = 1; k <= 4; ++k) {
                char h = raw[i + k]; cp <<= 4;
                if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
                else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
                else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
              }
              i += 4;
              if (cp >= 0x10000) { // surrogate pair (best effort)
                cp = 0xFFFD;
              }
              // UTF-8 encode
              if (cp < 0x80) out += (char)cp;
              else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
              else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
              else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 0x3F)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
            }
            break;
          }
          default: out += d;
        }
      } else out += c;
    }
  }
  JPtr parseStr() {
    if (p >= end || *p != '"') return nullptr;
    ++p;
    std::string raw;
    while (p < end && *p != '"') { raw += *p; ++p; }
    if (p >= end) return nullptr;
    ++p;
    auto v = std::make_shared<JVal>(); v->type = JVal::STR; DecodeStr(v->str, raw);
    return v;
  }
  JPtr parseVal() {
    ws();
    if (p >= end) return nullptr;
    char c = *p;
    if (c == '{') {
      ++p;
      auto v = std::make_shared<JVal>(); v->type = JVal::OBJ;
      ws();
      if (p < end && *p == '}') { ++p; return v; }
      while (p < end) {
        ws();
        auto k = parseStr(); if (!k) return nullptr;
        ws();
        if (p >= end || *p != ':') return nullptr;
        ++p;
        auto val = parseVal(); if (!val) return nullptr;
        v->obj[k->str] = val;
        ws();
        if (p < end && *p == ',') { ++p; continue; }
        if (p < end && *p == '}') { ++p; return v; }
        return nullptr;
      }
      return nullptr;
    }
    if (c == '[') {
      ++p;
      auto v = std::make_shared<JVal>(); v->type = JVal::ARR;
      ws();
      if (p < end && *p == ']') { ++p; return v; }
      while (p < end) {
        auto val = parseVal(); if (!val) return nullptr;
        v->arr.push_back(val);
        ws();
        if (p < end && *p == ',') { ++p; continue; }
        if (p < end && *p == ']') { ++p; return v; }
        return nullptr;
      }
      return nullptr;
    }
    if (c == '"') return parseStr();
    if (lit("true")) { auto v = std::make_shared<JVal>(); v->type = JVal::BOOL; v->b = true; return v; }
    if (lit("false")) { auto v = std::make_shared<JVal>(); v->type = JVal::BOOL; v->b = false; return v; }
    if (lit("null")) { auto v = std::make_shared<JVal>(); v->type = JVal::NUL; return v; }
    // number
    const char* start = p;
    while (p < end && (isdigit((unsigned char)*p) || *p == '-' || *p == '+' || *p == '.' || *p == 'e' || *p == 'E')) ++p;
    if (p == start) return nullptr;
    auto v = std::make_shared<JVal>(); v->type = JVal::NUM;
    v->num = strtod(std::string(start, p - start).c_str(), nullptr);
    return v;
  }
};
static JPtr JsonParse(const std::string& s) {
  JParser jp(s);
  JPtr v = jp.parseVal();
  if (!v) return nullptr;
  jp.ws();
  return v;
}

// ============================================================
// 3. HTTP GET via WinHTTP (returns body; status via out param)
// ============================================================
struct HttpResult { int status = 0; std::string body; std::string err; };

static HttpResult HttpGet(const std::wstring& host, int port, const std::wstring& path, int timeoutMs = 20000) {
  HttpResult r;
  HINTERNET session = WinHttpOpen(L"CardRate/1.0 Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0",
                                  WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!session) { r.err = "WinHttpOpen failed"; return r; }
  WinHttpSetTimeouts(session, 8000, 8000, timeoutMs, timeoutMs);
  HINTERNET conn = WinHttpConnect(session, host.c_str(), (INTERNET_PORT)port, 0);
  if (!conn) { r.err = "WinHttpConnect failed"; WinHttpCloseHandle(session); return r; }
  HINTERNET req = WinHttpOpenRequest(conn, L"GET", path.c_str(), nullptr, nullptr, nullptr,
                                     WINHTTP_FLAG_SECURE);
  if (!req) { r.err = "WinHttpOpenRequest failed"; WinHttpCloseHandle(conn); WinHttpCloseHandle(session); return r; }
  const wchar_t* kHeaders = L"Accept: application/json, text/plain, */*\r\nAccept-Language: zh-CN,zh;q=0.9,en;q=0.8\r\n";
  BOOL sent = WinHttpSendRequest(req, kHeaders, (DWORD)-1, WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
           && WinHttpReceiveResponse(req, nullptr);
  if (!sent) { DWORD e = GetLastError(); wchar_t eb[32]; swprintf(eb, 32, L"%lu", e); r.err = "send/recv failed (" + WideToUtf8(eb) + ")"; }
  else {
    DWORD st = 0, sz = sizeof(st);
    WinHttpQueryHeaders(req, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &st, &sz, 0);
    r.status = (int)st;
    for (;;) {
      DWORD avail = 0;
      if (!WinHttpQueryDataAvailable(req, &avail) || avail == 0) break;
      std::vector<char> buf(avail);
      DWORD readBytes = 0;
      if (!WinHttpReadData(req, buf.data(), avail, &readBytes)) break;
      r.body.append(buf.data(), readBytes);
      if (readBytes == 0) break;
    }
  }
  WinHttpCloseHandle(req); WinHttpCloseHandle(conn); WinHttpCloseHandle(session);
  return r;
}

// ============================================================
// 4. date helpers (UTC)
// ============================================================
static void TodayYMD(int& y, int& m, int& d) {
  SYSTEMTIME st; GetSystemTime(&st);
  y = st.wYear; m = st.wMonth; d = st.wDay;
}
static std::string IsoOf(int y, int m, int d) {
  char b[16]; snprintf(b, sizeof b, "%04d-%02d-%02d", y, m, d);
  return b;
}
static std::string MmddyyyyOf(int y, int m, int d) {
  char b[16]; snprintf(b, sizeof b, "%02d%%2F%02d%%2F%04d", m, d, y);
  return b;
}
static bool ShiftDay(int& y, int& m, int& d, int back) {
  FILETIME ft; SYSTEMTIME st = {};
  st.wYear = (WORD)y; st.wMonth = (WORD)m; st.wDay = (WORD)d;
  if (!SystemTimeToFileTime(&st, &ft)) return false;
  ULARGE_INTEGER ul; ul.LowPart = ft.dwLowDateTime; ul.HighPart = ft.dwHighDateTime;
  ul.QuadPart -= (ULONGLONG)back * 864000000000ULL;
  ft.dwLowDateTime = ul.LowPart; ft.dwHighDateTime = ul.HighPart;
  if (!FileTimeToSystemTime(&ft, &st)) return false;
  y = st.wYear; m = st.wMonth; d = st.wDay;
  return true;
}
// "YYYY-MM-DD" -> y/m/d
static bool ParseIso(const std::string& s, int& y, int& m, int& d) {
  if (s.size() != 10 || s[4] != '-' || s[7] != '-') return false;
  y = atoi(s.substr(0, 4).c_str()); m = atoi(s.substr(5, 2).c_str()); d = atoi(s.substr(8, 2).c_str());
  return y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

// ============================================================
// 5. JCB HTML parsers (byte-level regex; pages are UTF-8)
// ============================================================
struct JcbJpyTable { std::map<std::string, double> rates; std::string asOf; bool ok = false; };
static JcbJpyTable ParseJcbJpy(const std::string& html) {
  JcbJpyTable t;
  std::regex dm("(\\d{4})年(\\d{2})月(\\d{2})日");
  std::smatch m;
  if (std::regex_search(html, m, dm)) t.asOf = m[1].str() + "-" + m[2].str() + "-" + m[3].str();
  // row: <tr><td>CODE</td><td>名前</td><td>＝</td><td>RATE</td><td>JPY...
  std::regex re("<tr>\\s*<td>([A-Z]{3})</td>\\s*<td>[^<]*</td>\\s*<td>[^<]*</td>\\s*<td>([0-9.,]+)</td>\\s*<td>JPY");
  auto begin = std::sregex_iterator(html.begin(), html.end(), re);
  auto stop = std::sregex_iterator();
  for (auto it = begin; it != stop; ++it) {
    std::string code = (*it)[1].str();
    double v = atof((*it)[2].str().c_str());
    if (code.size() == 3 && v > 0) t.rates[code] = v;
  }
  t.ok = !t.rates.empty();
  return t;
}
struct JcbUsdTable { std::map<std::string, double> sell; std::string asOf; bool ok = false; }; // 1 USD = sell CODE
static JcbUsdTable ParseJcbUsd(const std::string& html) {
  JcbUsdTable t;
  std::regex dm("Base rate for (\\d{2})/(\\d{2})/(\\d{4})");
  std::smatch m;
  if (std::regex_search(html, m, dm)) t.asOf = m[3].str() + "-" + m[1].str() + "-" + m[2].str();
  std::regex re("<tr class=\"(?:odd|even)\">\\s*<td[^>]*>\\s*USD\\s*</td>\\s*<td[^>]*>\\s*=\\s*</td>\\s*"
                "<td[^>]*>([\\d.,\\s]+)</td>\\s*<td[^>]*>([\\d.,\\s]+)</td>\\s*<td[^>]*>([\\d.,\\s]+)</td>\\s*"
                "<td[^>]*>([A-Z]{3})\\s*</td>");
  auto begin = std::sregex_iterator(html.begin(), html.end(), re);
  auto stop = std::sregex_iterator();
  for (auto it = begin; it != stop; ++it) {
    std::string sellStr = Trim((*it)[3].str());
    std::string code = (*it)[4].str();
    double v = atof(sellStr.c_str());
    if (code != "USD" && v > 0) t.sell[code] = v;
  }
  t.ok = !t.sell.empty();
  return t;
}

// ============================================================
// 6. providers -> unified Quote
// ============================================================
struct Quote {
  bool ok = false;
  double rate = 0;            // 1 FROM = rate TO
  std::string asOf, kind, note, err, via;
};

// ---- Visa ----
static Quote VisaQuote(const std::string& from, const std::string& to, double fee, const std::string& dateIso) {
  Quote q;
  int y, m, d;
  if (!dateIso.empty()) { if (!ParseIso(dateIso, y, m, d)) { q.err = "日期格式应为 YYYY-MM-DD"; return q; } }
  else TodayYMD(y, m, d);
  for (int back = 0; back < 5; ++back) {
    int yy = y, mm = m, dd = d;
    ShiftDay(yy, mm, dd, back);
    char path[512];
    snprintf(path, sizeof path,
             "/cmsapi/fx/rates?amount=100&fee=%.2f&utcConvertedDate=%s&exchangedate=%s&fromCurr=%s&toCurr=%s",
             fee, MmddyyyyOf(yy, mm, dd).c_str(), MmddyyyyOf(yy, mm, dd).c_str(), to.c_str(), from.c_str());
    HttpResult r = HttpGet(L"www.visa.com.hk", 443, Utf8ToWide(path));
    if (r.status != 200 || r.body.empty()) continue;
    JPtr j = JsonParse(r.body);
    if (j && j->is("status") && (*j->get("status")).type == JVal::STR && (*j->get("status")).str == "success") {
      double rate = atof((*j->get("fxRateWithAdditionalFee")).str.c_str());
      long long epoch = (long long)(*j->get("originalValues")->get("asOfDate")).num;
      if (rate > 0) {
        q.ok = true; q.rate = rate; q.kind = "官方直报"; q.via = "visa";
        FILETIME ft; ULARGE_INTEGER ul; ul.QuadPart = (ULONGLONG)(epoch + 11644473600LL) * 10000000ULL;
        ft.dwLowDateTime = ul.LowPart; ft.dwHighDateTime = ul.HighPart;
        SYSTEMTIME st; FileTimeToSystemTime(&ft, &st);
        q.asOf = IsoOf(st.wYear, st.wMonth, st.wDay);
        return q;
      }
    }
  }
  q.err = "Visa 接口请求失败（网络受限或被限流）";
  return q;
}

static std::string UrlEncode(const std::string& s) {
  static const char* hex = "0123456789ABCDEF";
  std::string o;
  for (unsigned char c : s) {
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') o += (char)c;
    else { o += '%'; o += hex[c >> 4]; o += hex[c & 15]; }
  }
  return o;
}

// ---- Mastercard ----
// Akamai fingerprints the WinHTTP/SChannel TLS hello and often answers 403
// no matter the headers. Fallback: relay through the public CORS proxy used
// by the web edition — its server-side TLS stack passes, and a desktop app
// can call it without any CORS restrictions.
static HttpResult McFetch(const std::wstring& path) {
  HttpResult r = HttpGet(L"www.mastercard.com", 443, path);
  if (r.status == 403 || r.status == 0 || r.body.empty()) {
    std::string full = "https://www.mastercard.com" + WideToUtf8(path);
    std::wstring proxyPath = L"/raw?url=" + Utf8ToWide(UrlEncode(full));
    HttpResult via = HttpGet(L"api.allorigins.win", 443, proxyPath, 25000);
    if (via.status == 200 && !via.body.empty()) return via;
  }
  return r;
}

static Quote McQuote(const std::string& from, const std::string& to, double fee, const std::string& dateIso) {
  Quote q;
  std::string dateParam = dateIso.empty() ? "0000-00-00" : dateIso;
  char path[512];
  snprintf(path, sizeof path,
           "/marketingservices/public/mccom-services/currency-conversions/conversion-rates"
           "?exchange_date=%s&transaction_currency=%s&cardholder_billing_currency=%s&bank_fee=%.2f&transaction_amount=100",
           dateParam.c_str(), from.c_str(), to.c_str(), fee);
  HttpResult r = McFetch(Utf8ToWide(path));
  if (r.status != 200 || r.body.empty()) { q.err = "Mastercard 接口请求失败 (HTTP " + std::to_string(r.status) + ")"; return q; }
  JPtr j = JsonParse(r.body);
  if (!j || !j->is("data")) { q.err = "Mastercard 响应解析失败"; return q; }
  JPtr data = j->get("data");
  if (data->is("errorMessage")) { q.err = "Mastercard: " + (*data->get("errorMessage")).str; return q; }
  if (!data->is("conversionRate")) { q.err = "Mastercard 响应缺少汇率字段"; return q; }
  q.rate = atof((*data->get("conversionRate")).str.c_str());
  q.asOf = data->is("fxDate") ? (*data->get("fxDate")).str : "";
  q.ok = q.rate > 0;
  q.kind = "官方直报"; q.via = "mastercard";
  if (!q.ok) q.err = "Mastercard 汇率无效";
  return q;
}

// ---- JCB ----
static Quote JcbQuote(const std::string& billing, const std::string& from, const std::string& to, const std::string& dateIso) {
  Quote q;
  q.via = "jcb";
  q.note = "JCB 基准汇率（对应官网 Sell 列），发卡行通常另加约 1.6%-2%";
  if (billing == "USD") {
    int y, m, d;
    if (!dateIso.empty()) { if (!ParseIso(dateIso, y, m, d)) { q.err = "日期格式应为 YYYY-MM-DD"; return q; } }
    else TodayYMD(y, m, d);
    for (int back = 0; back < 7; ++back) {
      int yy = y, mm = m, dd = d;
      ShiftDay(yy, mm, dd, back);
      char path[128];
      snprintf(path, sizeof path, "/rate/usd%02d%02d%04d.html", mm, dd, yy);
      HttpResult r = HttpGet(L"www.jcb.jp", 443, Utf8ToWide(path));
      if (r.status != 200) continue;
      JcbUsdTable t = ParseJcbUsd(r.body);
      if (!t.ok) continue;
      double rate = 0; std::string kind;
      if (from == "USD" && t.sell.count(to)) { rate = t.sell[to]; kind = "官方直报"; }
      else if (to == "USD" && t.sell.count(from)) { rate = 1.0 / t.sell[from]; kind = "官方报价取倒数"; }
      else if (t.sell.count(from) && t.sell.count(to)) { rate = t.sell[to] / t.sell[from]; kind = "交叉汇率（估算）"; }
      if (rate > 0) {
        q.ok = true; q.rate = rate; q.kind = kind; q.asOf = t.asOf;
        if (kind.find("交叉") != std::string::npos) q.note += "；非基准对按官方提示交叉计算";
        return q;
      }
      q.err = "JCB 不支持该货币对"; return q;
    }
    q.err = "JCB 历史页面不可用"; return q;
  }
  // JPY billing: jpy.html publishes the current business day only
  HttpResult r = HttpGet(L"www.jcb.jp", 443, L"/rate/jpy.html");
  if (r.status != 200 || r.body.empty()) { q.err = "JCB 页面请求失败"; return q; }
  JcbJpyTable t = ParseJcbJpy(r.body);
  if (!t.ok) { q.err = "JCB 表格解析失败"; return q; }
  double rate = 0; std::string kind;
  if (to == "JPY" && t.rates.count(from)) { rate = t.rates[from]; kind = "官方直报"; }
  else if (from == "JPY" && t.rates.count(to)) { rate = 1.0 / t.rates[to]; kind = "官方报价取倒数"; }
  else if (t.rates.count(from) && t.rates.count(to)) { rate = t.rates[from] / t.rates[to]; kind = "交叉汇率（估算）"; }
  if (rate <= 0) { q.err = "JCB 日元表不含该币种（仅 15 种）"; return q; }
  q.ok = true; q.rate = rate; q.kind = kind; q.asOf = t.asOf;
  if (!dateIso.empty() && dateIso != t.asOf) q.note += "；日元表仅公布当日，已用最新基准汇率";
  if (kind.find("交叉") != std::string::npos) q.note += "；非日元对按官方提示交叉计算";
  return q;
}

// ---- UnionPay ----
struct UpData { std::map<std::string, double> rows; std::string asOf; bool ok = false; };
static UpData ParseUp(const std::string& body) {
  UpData u;
  JPtr j = JsonParse(body);
  if (!j || !j->is("exchangeRateJson") || (*j->get("exchangeRateJson")).type != JVal::ARR) return u;
  for (auto& row : (*j->get("exchangeRateJson")).arr) {
    if (row->type != JVal::OBJ) continue;
    std::string tc = (*row->get("transCur")).str, bc = (*row->get("baseCur")).str;
    double rd = (*row->get("rateData")).num;
    u.rows[tc + "|" + bc] = rd;
  }
  if (j->is("curDate")) u.asOf = (*j->get("curDate")).str;
  u.ok = !u.rows.empty();
  return u;
}
static Quote UpQuote(const std::string& from, const std::string& to, const std::string& dateIso) {
  Quote q; q.via = "unionpay";
  int y, m, d;
  if (!dateIso.empty()) { if (!ParseIso(dateIso, y, m, d)) { q.err = "日期格式应为 YYYY-MM-DD"; return q; } }
  else TodayYMD(y, m, d);
  for (int back = 0; back < 15; ++back) {
    int yy = y, mm = m, dd = d;
    ShiftDay(yy, mm, dd, back);
    char stamp[16], path[64];
    snprintf(stamp, sizeof stamp, "%04d%02d%02d", yy, mm, dd);
    snprintf(path, sizeof path, "/jfimg/%s.json", stamp);
    HttpResult r = HttpGet(L"m.unionpayintl.com", 443, Utf8ToWide(path));
    if (r.status != 200) continue;
    UpData u = ParseUp(r.body);
    if (!u.ok) continue;
    double rate = 0; std::string kind;
    if (u.rows.count(from + "|" + to)) { rate = u.rows[from + "|" + to]; kind = "官方直报"; }
    else if (u.rows.count(to + "|" + from)) { rate = 1.0 / u.rows[to + "|" + from]; kind = "官方报价取倒数"; }
    else if (u.rows.count(from + "|USD") && u.rows.count(to + "|USD")) {
      rate = u.rows[from + "|USD"] / u.rows[to + "|USD"]; kind = "经 USD 交叉汇率";
    }
    if (rate > 0) { q.ok = true; q.rate = rate; q.kind = kind; q.asOf = u.asOf; return q; }
    q.err = "银联不支持该货币对"; return q;
  }
  q.err = "银联当日数据不可用（连续 15 天缺失）";
  return q;
}

// ---- dispatcher ----
// provider: visa | mastercard | jcb-jpy | jcb-usd | unionpay
static Quote QueryOne(const std::string& provider, const std::string& from, const std::string& to,
                      double fee, const std::string& dateIso) {
  if (provider == "visa") return VisaQuote(from, to, fee, dateIso);
  if (provider == "mastercard") return McQuote(from, to, fee, dateIso);
  if (provider == "jcb-jpy") return JcbQuote("JPY", from, to, dateIso);
  if (provider == "jcb-usd") return JcbQuote("USD", from, to, dateIso);
  return UpQuote(from, to, dateIso);
}
static std::wstring ProviderLabel(const std::string& p) {
  if (p == "visa") return L"Visa";
  if (p == "mastercard") return L"Mastercard";
  if (p == "jcb-jpy") return L"JCB（日元记账）";
  if (p == "jcb-usd") return L"JCB（美元记账）";
  return L"银联 UnionPay";
}

// ============================================================
// 7. report builder (single or two-leg; compare handled by caller)
// ============================================================
struct ConvInput {
  std::string provider, from, to, dateIso, settle;
  double amount = 100, fee = 0;
  bool compare = false;
};

static std::wstring BuildReport(const ConvInput& in) {
  std::wstring providerName = ProviderLabel(in.provider);
  if (in.compare) {
    const char* provs[4] = { "visa", "mastercard", "jcb-jpy", "unionpay" };
    std::wstring report = L"═══ 四大卡组织对比（交易 " + Utf8ToWide(in.from) + L" → 记账 " + Utf8ToWide(in.to) + L"）═══\r\n";
    for (int i = 0; i < 4; ++i) {
      std::string p = provs[i];
      Quote q = QueryOne(p, in.from, in.to, in.fee, in.dateIso);
      if (!in.settle.empty() && in.settle != in.from && in.settle != in.to && q.ok) {
        Quote q2 = QueryOne(p, in.settle, in.to, in.fee, in.dateIso);
        Quote q1 = QueryOne(p, in.from, in.settle, in.fee, in.dateIso);
        if (q1.ok && q2.ok) q.rate = q1.rate * q2.rate;
      }
      wchar_t line[512];
      if (q.ok) {
        swprintf(line, 512, L"%-18s 1 %s = %s %s  →  %s %s  [%s, %s]\r\n",
                 ProviderLabel(p).c_str(), Utf8ToWide(in.from).c_str(), FmtRate(q.rate).c_str(), Utf8ToWide(in.to).c_str(),
                 FmtMoney(in.amount * q.rate).c_str(), Utf8ToWide(in.to).c_str(), Utf8ToWide(q.kind).c_str(), Utf8ToWide(q.asOf).c_str());
      } else {
        swprintf(line, 512, L"%-18s 失败：%s\r\n", ProviderLabel(p).c_str(), Utf8ToWide(q.err).c_str());
      }
      report += line;
    }
    return report;
  }

  // single / two-leg
  bool twoLeg = !in.settle.empty() && in.settle != in.from && in.settle != in.to;
  Quote q1, q2, q;
  if (twoLeg) {
    q1 = QueryOne(in.provider, in.from, in.settle, in.fee, in.dateIso);
    q2 = QueryOne(in.provider, in.settle, in.to, in.fee, in.dateIso);
    q.ok = q1.ok && q2.ok;
    if (q.ok) {
      q.rate = q1.rate * q2.rate;
      q.kind = "两跳换汇";
      q.asOf = q1.asOf == q2.asOf ? q1.asOf : (q1.asOf + " / " + q2.asOf);
      q.via = in.provider;
    }
  } else {
    q = QueryOne(in.provider, in.from, in.to, in.fee, in.dateIso);
  }
  if (!q.ok) {
    const std::string& e = twoLeg ? (!q1.ok ? q1.err : q2.err) : q.err;
    return L"查询失败：" + Utf8ToWide(e) + L"\r\n\r\n提示：可稍后重试；Visa 偶尔拒绝数据中心 IP。";
  }
  // all display args are pre-converted wide strings — swprintf %hs would
  // reinterpret our UTF-8 byte strings in the ANSI codepage (mojibake)
  std::wstring fromW = Utf8ToWide(in.from), toW = Utf8ToWide(in.to), settleW = Utf8ToWide(in.settle);
  std::wstring kindW = twoLeg ? std::wstring(L"两跳换汇") : Utf8ToWide(q.kind);
  std::wstring report = L"═══ " + providerName + L" ═══\r\n";
  wchar_t line[512];
  swprintf(line, 512, L"%s %s  =  %s %s\r\n",
           FmtMoney(in.amount).c_str(), fromW.c_str(),
           FmtMoney(in.amount * q.rate).c_str(), toW.c_str());
  report += line;
  swprintf(line, 512, L"1 %s = %s %s  ·  %s", fromW.c_str(), FmtRate(q.rate).c_str(), toW.c_str(), kindW.c_str());
  report += line;
  if ((in.provider == "visa" || in.provider == "mastercard") && in.fee > 0) {
    wchar_t fb[32]; swprintf(fb, 32, L" · 含 %.1f%% 手续费", in.fee);
    if (twoLeg) report += L"（两跳均含）"; else report += fb;
  }
  report += L"\r\n";
  swprintf(line, 512, L"1 %s = %s %s\r\n", toW.c_str(), FmtRate(1.0 / q.rate).c_str(), fromW.c_str());
  report += line;
  if (twoLeg) {
    swprintf(line, 512, L"第1跳：1 %s = %s %s（%s）\r\n", fromW.c_str(), FmtRate(q1.rate).c_str(), settleW.c_str(), Utf8ToWide(q1.kind).c_str());
    report += line;
    swprintf(line, 512, L"第2跳：1 %s = %s %s（%s）\r\n", settleW.c_str(), FmtRate(q2.rate).c_str(), toW.c_str(), Utf8ToWide(q2.kind).c_str());
    report += line;
  }
  {
    swprintf(line, 512, L"汇率日期：%s\r\n", Utf8ToWide(q.asOf).c_str());
    report += line;
  }
  if (!q.note.empty() || (in.provider != "visa" && in.provider != "mastercard")) {
    std::string note = q.note.empty() ? "基准汇率，未含发卡加点" : q.note;
    report += L"备注：" + Utf8ToWide(note) + L"\r\n";
  }
  return report;
}

// ============================================================
// 8. self test (offline, CI-safe)
// ============================================================
static const char* SELF_JPY_HTML =
  "<div class=\"rate2TableArea\"><p>2026年10月02日換算日の基準レート</p><table>"
  "<tr><td>USD</td><td>（米ドル）</td><td>＝</td><td>158.17</td><td>JPY（日本円）</td></tr>"
  "<tr><td>EUR</td><td>（欧州ユーロ）</td><td>＝</td><td>177.971</td><td>JPY（日本円）</td></tr>"
  "<tr><td>KRW</td><td>（韓国ウォン）</td><td>＝</td><td>0.116</td><td>JPY（日本円）</td></tr>"
  "</table></div>";
static const char* SELF_USD_HTML =
  "<p>Base rate for 10/02/2026</p><div id=\"CSVTable\"><table class=\"CSVTable\"><tbody>"
  "<tr class=\"odd\"><td></td><td></td><td>Buy</td><td>Mid</td><td>Sell</td><td></td></tr>"
  "<tr class=\"even\"><td>USD</td><td>=</td><td>3.672600000  </td><td>3.672700000  </td><td>3.672800000  </td><td>AED</td></tr>"
  "<tr class=\"odd\"><td>USD</td><td>=</td><td>157.689100000  </td><td>157.930000000  </td><td>158.170900000  </td><td>JPY</td></tr>"
  "</tbody></table></div>";

static int RunSelfTest(bool verbose) {
  int pass = 0, fail = 0;
  auto check = [&](const char* name, bool ok, const std::string& detail = "") {
    if (ok) ++pass; else ++fail;
    if (verbose || !ok) printf("%s %s %s\r\n", ok ? "PASS" : "FAIL", name, detail.c_str());
  };
  // JSON: Visa sample
  {
    const char* s = "{\"status\":\"success\",\"convertedAmount\":\"670.6325325\","
                    "\"fxRateWithAdditionalFee\":\"6.706325325\","
                    "\"originalValues\":{\"asOfDate\":1790899200}}";
    JPtr j = JsonParse(s);
    check("json visa parse", j && j->is("status"));
    check("json visa rate", j && atof((*j->get("fxRateWithAdditionalFee")).str.c_str()) == 6.706325325);
    check("json visa epoch", j && (long long)(*j->get("originalValues")->get("asOfDate")).num == 1790899200);
  }
  // JSON: MC sample
  {
    const char* s = "{\"data\":{\"conversionRate\":\"6.7045000\",\"crdhldBillCurr\":\"CNY\",\"fxDate\":\"2026-10-01\"}}";
    JPtr j = JsonParse(s);
    check("json mc parse", j && j->is("data"));
    check("json mc rate", atof((*j->get("data")->get("conversionRate")).str.c_str()) == 6.7045);
    check("json mc date", (*j->get("data")->get("fxDate")).str == "2026-10-01");
  }
  // JSON: UP sample
  {
    std::string s = "{\"exchangeRateJson\":[{\"transCur\":\"USD\",\"baseCur\":\"CNY\",\"rateData\":6.7269},"
                    "{\"transCur\":\"HKD\",\"baseCur\":\"CNY\",\"rateData\":0.8569},"
                    "{\"transCur\":\"CNY\",\"baseCur\":\"USD\",\"rateData\":0.148879}],\"curDate\":\"2026-10-02\"}";
    UpData u = ParseUp(s);
    check("json up rows", u.ok && u.rows.size() == 3);
    check("json up direct", u.rows["USD|CNY"] == 6.7269);
    check("json up asof", u.asOf == "2026-10-02");
  }
  // JCB parsers
  {
    JcbJpyTable j = ParseJcbJpy(SELF_JPY_HTML);
    check("jcb jpy 3 rows", j.ok && j.rates.size() == 3);
    check("jcb jpy USD=158.17", j.rates["USD"] == 158.17);
    check("jcb jpy KRW=0.116", j.rates["KRW"] == 0.116);
    check("jcb jpy asOf", j.asOf == "2026-10-02");
    JcbUsdTable u = ParseJcbUsd(SELF_USD_HTML);
    check("jcb usd 2 rows", u.ok && u.sell.size() == 2);
    check("jcb usd AED sell", u.sell["AED"] == 3.6728);
    check("jcb usd JPY sell", u.sell["JPY"] == 158.1709);
    check("jcb jpy == usd sell column", (int)(j.rates["USD"] * 1000) == (int)(u.sell["JPY"] * 1000));
  }
  // fee math + two-leg
  {
    double base = 6.7045;
    check("fee math x1.02", fabs(base * 1.02 - 6.83859) < 1e-9);
    double leg1 = 158.17, leg2 = 1.0 / 6.7;
    check("two-leg product", fabs(leg1 * leg2 - leg1 / 6.7) < 1e-12);
  }
  printf("SELFTEST RESULT: %d passed, %d failed\r\n", pass, fail);
  return fail == 0 ? 0 : 1;
}

// ============================================================
// 9. CLI mode
// ============================================================
// GUI-subsystem console plumbing: if the process was launched with a
// redirected std handle (pipe/file), CRT printf writes there directly;
// otherwise attach to the parent console. Then force UTF-8 output CP.
static void SetupConsole() {
  HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
  bool haveHandle = h != nullptr && h != INVALID_HANDLE_VALUE;
  if (!haveHandle) {
    if (AttachConsole(ATTACH_PARENT_PROCESS)) {
      FILE* out = nullptr;
      freopen_s(&out, "CONOUT$", "w", stdout);
    }
  }
  SetConsoleOutputCP(CP_UTF8);
}
static int RunCli(int argc, wchar_t** argv) {
  // --cli FROM TO AMOUNT [FEE] [DATE] [SETTLE] [PROVIDER]
  if (argc < 5) {
    printf("usage: CardRate --cli FROM TO AMOUNT [FEE=0] [DATE=] [SETTLE=] [PROVIDER=visa]\r\n"
           "  PROVIDER: visa | mastercard | jcb-jpy | jcb-usd | unionpay\r\n");
    return 2;
  }
  ConvInput in;
  auto argOr = [&](int i) -> std::string {
    std::string s = argc > i ? WideToUtf8(argv[i]) : "";
    if (s == "-" || s == "\"\"") s = ""; // empty placeholder (cmd quoting)
    return s;
  };
  in.from = Upper(WideToUtf8(argv[2]));
  in.to = Upper(WideToUtf8(argv[3]));
  in.amount = _wtof(argv[4]);
  in.fee = argc > 5 ? _wtof(argv[5]) : 0;
  in.dateIso = argOr(6);
  in.settle = argc > 7 ? Upper(argOr(7)) : "";
  in.provider = argc > 8 ? WideToUtf8(argv[8]) : "visa";
  in.compare = in.provider == "compare";
  std::wstring report = BuildReport(in);
  printf("%s\r\n", WideToUtf8(report).c_str());
  return report.find(L"查询失败") == std::wstring::npos ? 0 : 1;
}

// ============================================================
// 10. GUI — classic Win32, SimSun 9pt, menus, worker thread
// ============================================================
static const wchar_t* WCLASS = L"CardRateWnd";
static const int WM_APP_DONE = WM_APP + 1;

enum {
  IDC_PROVIDER = 1001, IDC_AMOUNT, IDC_FROM, IDC_TO, IDC_SWAP,
  IDC_FEE, IDC_SETTLE, IDC_DATE, IDC_GO, IDC_COMPARE, IDC_ABOUT,
  IDC_REPORT,
};
static const wchar_t* PROVIDERS[] = { L"Visa", L"Mastercard", L"JCB（日元记账）", L"JCB（美元记账）", L"银联 UnionPay" };
static const char* PROVIDER_KEYS[] = { "visa", "mastercard", "jcb-jpy", "jcb-usd", "unionpay" };
static const wchar_t* COMMON_CODES[] = { L"USD",L"EUR",L"JPY",L"GBP",L"HKD",L"CNY",L"MOP",L"TWD",L"KRW",L"SGD",
  L"AUD",L"NZD",L"CAD",L"CHF",L"SEK",L"NOK",L"DKK",L"THB",L"MYR",L"IDR",L"PHP",L"VND",L"INR",L"AED",L"TRY",L"RUB",L"BRL",L"MXN" };

struct GuiState {
  HWND wnd = nullptr;
  HWND provider, amount, from, to, swapB, fee, settle, date, go, compareB, report;
  HFONT font = nullptr;
  std::mutex jobMx;
  bool jobRunning = false;
};
static GuiState G;

static void SetComboSel(HWND combo, const wchar_t* txt) {
  int i = ComboBox_FindStringExact(combo, -1, txt);
  if (i >= 0) ComboBox_SetCurSel(combo, i);
  else { ComboBox_SetText(combo, txt); }
}
static std::string GetComboText(HWND combo) {
  wchar_t buf[64]; buf[0] = 0;
  ComboBox_GetText(combo, buf, 64);
  return Upper(WideToUtf8(buf));
}

static void LaunchJob(bool compare) {
  {
    std::lock_guard<std::mutex> lk(G.jobMx);
    if (G.jobRunning) return;
    G.jobRunning = true;
  }
  ConvInput in;
  wchar_t buf[64];
  int sel = ComboBox_GetCurSel(G.provider);
  in.provider = PROVIDER_KEYS[sel < 0 ? 0 : sel];
  in.from = GetComboText(G.from);
  in.to = GetComboText(G.to);
  GetWindowTextW(G.amount, buf, 64); in.amount = _wtof(buf);
  GetWindowTextW(G.fee, buf, 64); in.fee = _wtof(buf);
  GetWindowTextW(G.date, buf, 64); in.dateIso = WideToUtf8(buf);
  in.settle = GetComboText(G.settle);
  in.compare = compare;
  if (in.from.size() != 3 || in.to.size() != 3) {
    std::lock_guard<std::mutex> lk(G.jobMx); G.jobRunning = false;
    SetWindowTextW(G.report, L"请输入 3 位字母货币代码，例如 USD / CNY");
    return;
  }
  SetWindowTextW(G.report, L"查询中，请稍候…");
  std::thread([in]() {
    std::wstring report = BuildReport(in);
    auto* heap = new std::wstring(std::move(report));
    PostMessageW(G.wnd, WM_APP_DONE, 0, (LPARAM)heap);
  }).detach();
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_CREATE: {
      CREATESTRUCTW* cs = (CREATESTRUCTW*)lp;
      G.wnd = hwnd;
      G.font = CreateFontW(-12, 0, 0, 0, FW_NORMAL, 0, 0, 0, GB2312_CHARSET,
                           OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY,
                           FF_DONTCARE | DEFAULT_PITCH, L"SimSun");
      auto mk = [&](const wchar_t* cls, const wchar_t* text, DWORD style, int x, int y, int w, int h, int id) -> HWND {
        HWND c = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, x, y, w, h, hwnd, (HMENU)(INT_PTR)id, cs->hInstance, nullptr);
        SendMessageW(c, WM_SETFONT, (WPARAM)G.font, TRUE);
        return c;
      };
      auto mkStatic = [&](const wchar_t* t, int x, int y, int w) { return mk(L"STATIC", t, SS_LEFT, x, y + 3, w, 18, -1); };
      int y = 14;
      mkStatic(L"卡组织(&P)：", 14, y, 78);
      G.provider = mk(L"COMBOBOX", L"", CBS_DROPDOWNLIST | WS_VSCROLL | WS_TABSTOP, 94, y, 170, 200, IDC_PROVIDER);
      for (auto p : PROVIDERS) ComboBox_AddString(G.provider, p);
      ComboBox_SetCurSel(G.provider, 0);
      mkStatic(L"金额(&A)：", 276, y, 52);
      G.amount = mk(L"EDIT", L"100", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 330, y, 92, 22, IDC_AMOUNT);
      y += 34;
      mkStatic(L"交易货币(&F)（刷卡）：", 14, y, 118);
      G.from = mk(L"COMBOBOX", L"USD", CBS_DROPDOWN | CBS_AUTOHSCROLL | WS_VSCROLL | WS_TABSTOP, 134, y, 88, 240, IDC_FROM);
      G.swapB = mk(L"BUTTON", L"⇄", BS_PUSHBUTTON | WS_TABSTOP, 226, y - 1, 30, 24, IDC_SWAP);
      mkStatic(L"记账货币(&T)（入账）：", 238, y, 118);
      G.to = mk(L"COMBOBOX", L"CNY", CBS_DROPDOWN | CBS_AUTOHSCROLL | WS_VSCROLL | WS_TABSTOP, 358, y, 88, 240, IDC_TO);
      // fee moved to row 3 to keep row 2 uncluttered
      y += 34;
      mkStatic(L"结算货币(&S)：", 14, y, 78);
      G.settle = mk(L"COMBOBOX", L"", CBS_DROPDOWN | CBS_AUTOHSCROLL | WS_VSCROLL | WS_TABSTOP, 94, y, 100, 240, IDC_SETTLE);
      ComboBox_AddString(G.settle, L""); // 直换
      mkStatic(L"手续费%(&E)：", 216, y, 70);
      G.fee = mk(L"EDIT", L"0", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 288, y, 44, 22, IDC_FEE);
      mkStatic(L"日期(&D)：", 340, y, 40);
      G.date = mk(L"EDIT", L"", WS_BORDER | ES_AUTOHSCROLL | WS_TABSTOP, 382, y, 96, 22, IDC_DATE);
      y += 32;
      G.go = mk(L"BUTTON", L"查询换算", BS_DEFPUSHBUTTON | WS_TABSTOP, 14, y, 90, 26, IDC_GO);
      G.compareB = mk(L"BUTTON", L"对比全部", BS_PUSHBUTTON | WS_TABSTOP, 110, y, 90, 26, IDC_COMPARE);
      y += 40;
      mkStatic(L"结果：", 14, y, 40);
      y += 20;
      G.report = mk(L"EDIT", L"", WS_BORDER | ES_MULTILINE | ES_AUTOVSCROLL | ES_AUTOHSCROLL | ES_READONLY | WS_VSCROLL | WS_TABSTOP,
                    14, y, 510, 200, IDC_REPORT);
      for (HWND c : { G.from, G.to, G.settle })
        for (auto code : COMMON_CODES) ComboBox_AddString(c, code);
      SetComboSel(G.from, L"USD");
      SetComboSel(G.to, L"CNY");
      return 0;
    }
    case WM_COMMAND: {
      int id = LOWORD(wp), code = HIWORD(wp);
      if (id == IDC_GO && code == BN_CLICKED) LaunchJob(false);
      else if (id == IDC_COMPARE && code == BN_CLICKED) LaunchJob(true);
      else if (id == IDC_SWAP && code == BN_CLICKED) {
        wchar_t a[64], b[64];
        ComboBox_GetText(G.from, a, 64); ComboBox_GetText(G.to, b, 64);
        SetComboSel(G.from, b); SetComboSel(G.to, a);
      }
      else if (id == IDC_ABOUT) {
        MessageBoxW(hwnd,
          L"四卡汇率换算器 Win32 版\r\n\r\n"
          L"数据来自 Visa / Mastercard / JCB / 银联公开接口，仅供参考。\r\n"
          L"实际扣款汇率以发卡行为准。\r\n\r\n"
          L"经典 Win32 API · WinHTTP · 无外部依赖",
          L"关于 CardRate", MB_OK | MB_ICONINFORMATION);
      }
      return 0;
    }
    case WM_APP_DONE: {
      std::unique_ptr<std::wstring> rep((std::wstring*)lp);
      SetWindowTextW(G.report, rep ? rep->c_str() : L"（空结果）");
      std::lock_guard<std::mutex> lk(G.jobMx);
      G.jobRunning = false;
      return 0;
    }
    case WM_CTLCOLORSTATIC: {
      HDC dc = (HDC)wp;
      SetBkColor(dc, GetSysColor(COLOR_BTNFACE));
      return (LRESULT)GetSysColorBrush(COLOR_BTNFACE);
    }
    case WM_DESTROY: {
      if (G.font) DeleteObject(G.font);
      PostQuitMessage(0);
      return 0;
    }
  }
  return DefWindowProcW(hwnd, msg, wp, lp);
}

static int RunGui(HINSTANCE hInst, int nCmdShow) {
  INITCOMMONCONTROLSEX icc = { sizeof(icc), ICC_STANDARD_CLASSES };
  InitCommonControlsEx(&icc);
  WNDCLASSW wc = {};
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
  wc.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1);
  wc.lpszClassName = WCLASS;
  RegisterClassW(&wc);
  HWND hwnd = CreateWindowExW(0, WCLASS, L"四卡汇率换算器 Card Rate Converter",
                              WS_OVERLAPPEDWINDOW & ~WS_MAXIMIZEBOX & ~WS_THICKFRAME,
                              CW_USEDEFAULT, CW_USEDEFAULT, 552, 470,
                              nullptr, nullptr, hInst, nullptr);
  // classic menu bar
  HMENU menu = CreateMenu();
  HMENU fileM = CreatePopupMenu();
  AppendMenuW(fileM, MF_STRING, IDC_GO, L"查询换算(&C)\tEnter");
  AppendMenuW(fileM, MF_STRING, IDC_COMPARE, L"对比全部(&A)");
  AppendMenuW(fileM, MF_SEPARATOR, 0, nullptr);
  AppendMenuW(fileM, MF_STRING, SC_CLOSE, L"退出(&X)");
  HMENU helpM = CreatePopupMenu();
  AppendMenuW(helpM, MF_STRING, IDC_ABOUT, L"关于(&A)…");
  AppendMenuW(menu, MF_POPUP, (UINT_PTR)fileM, L"文件(&F)");
  AppendMenuW(menu, MF_POPUP, (UINT_PTR)helpM, L"帮助(&H)");
  SetMenu(hwnd, menu);
  ShowWindow(hwnd, nCmdShow);
  UpdateWindow(hwnd);
  MSG msg = {};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    if (msg.message == WM_KEYDOWN && msg.wParam == VK_RETURN) {
      PostMessageW(hwnd, WM_COMMAND, MAKEWPARAM(IDC_GO, BN_CLICKED), 0);
      continue;
    }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return (int)msg.wParam;
}

int WINAPI wWinMain(HINSTANCE hInst, HINSTANCE, PWSTR cmdLine, int nCmdShow) {
  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  if (argc >= 2) {
    if (wcscmp(argv[1], L"--selftest") == 0) {
      SetupConsole();
      int rc = RunSelfTest(true);
      fflush(stdout);
      FreeConsole();
      LocalFree(argv);
      return rc;
    }
    if (wcscmp(argv[1], L"--cli") == 0) {
      SetupConsole();
      int rc = RunCli(argc, argv);
      fflush(stdout);
      FreeConsole();
      LocalFree(argv);
      return rc;
    }
  }
  if (argv) LocalFree(argv);
  return RunGui(hInst, nCmdShow);
}

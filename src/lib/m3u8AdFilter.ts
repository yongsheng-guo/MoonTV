/**
 * 去广告：从 m3u8 播放列表中剔除插播广告分片。
 *
 * 背景：部分资源站（如 iKun）会在正片 m3u8 里插入广告分片，广告与正片
 * 来自不同的编码目录，且以 #EXT-X-DISCONTINUITY 分隔（广告段的时间戳
 * 从头开始，正片恢复后时间戳跳回正片时间线）。旧实现是把所有
 * #EXT-X-DISCONTINUITY 行删掉、一段也不删，hls.js 收不到时间戳跳变
 * 的信号，会把广告和正片拼到同一条时间线上，导致长片播到一半总时长
 * 缩水并提前结束（见 ikun《哈利波特与魔法石》id 569：4811 段、
 * 161.5 分钟，9 处插播广告，255 个 DISCONTINUITY）。
 *
 * 本实现只删分片本身（#EXTINF 行 + 分片 URL 行），其余行原样保留，
 * 包括全部 #EXT-X-DISCONTINUITY 标记——播放器仍能正确处理时间戳
 * 跳变；删段后留下的标记对应连续的时间戳，与源站每 20 段插一个
 * 的无害标记是同一情形。
 *
 * 广告识别：同一媒体播放列表内，占多数的分片 URL 目录即正片目录；
 * 连续出现的少数目录分片串视为插播广告。满足以下全部条件才删：
 * - 正片目录分片占比 >= 80%（否则无法确认哪个是正片，原样返回）；
 * - 每串广告分片 <= 12 段且总时长 <= 60 秒（长串不删，避免误删正片）；
 * - 广告串内每个 #EXTINF 都能解析出有限时长。
 * 不满足时原样返回（字节不变），master 播放列表、无广告播放列表
 * 均不受影响。
 */

interface Segment {
  /** 分片 URL 所在行号 */
  uriLine: number;
  /** #EXTINF 所在行号（-1 表示无，即不是媒体分片） */
  extinfLine: number;
  /** #EXTINF 声明的时长（秒） */
  duration: number;
  /** EXTINF 时长是否可解析 */
  durationValid: boolean;
  /** 分片 URL 的目录部分（去掉查询串/锚点后取到最后一个 '/'） */
  dir: string;
}

function segmentDir(uri: string): string {
  const clean = uri.split('?')[0].split('#')[0];
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(0, slash) : '';
}

/**
 * 过滤 m3u8 内容中的插播广告分片，返回过滤后的内容。
 * 无法确认广告时返回原内容（不做任何改动）。
 */
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';

  const lines = m3u8Content.split('\n');

  // 收集媒体分片：带 #EXTINF 的 URI 行才算分片，
  // master 列表的 variant URI（只有 #EXT-X-STREAM-INF）不在此列。
  const segments: Segment[] = [];
  let pendingExtinfLine = -1;
  let pendingDuration = 0;
  let pendingDurationValid = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF:')) {
      pendingExtinfLine = i;
      const raw = line.slice('#EXTINF:'.length).split(',')[0].trim();
      const parsed = Number.parseFloat(raw);
      pendingDuration = Number.isFinite(parsed) ? parsed : 0;
      pendingDurationValid = Number.isFinite(parsed);
    } else if (line && !line.startsWith('#')) {
      if (pendingExtinfLine >= 0) {
        segments.push({
          uriLine: i,
          extinfLine: pendingExtinfLine,
          duration: pendingDuration,
          durationValid: pendingDurationValid,
          dir: segmentDir(line),
        });
      }
      pendingExtinfLine = -1;
      pendingDuration = 0;
      pendingDurationValid = false;
    }
  }

  if (segments.length === 0) return m3u8Content;

  // 占多数的目录即正片目录
  const dirCount = new Map<string, number>();
  for (const seg of segments) {
    dirCount.set(seg.dir, (dirCount.get(seg.dir) ?? 0) + 1);
  }
  let mainDir = '';
  let mainCount = 0;
  dirCount.forEach((count, dir) => {
    if (count > mainCount) {
      mainDir = dir;
      mainCount = count;
    }
  });
  if (mainCount / segments.length < 0.8) return m3u8Content;

  // 找出连续的少数目录分片串，符合长度/时长上限的才删
  const MAX_AD_SEGMENTS = 12;
  const MAX_AD_DURATION_SECONDS = 60;
  const dropLines = new Set<number>();
  let i = 0;
  while (i < segments.length) {
    if (segments[i].dir === mainDir) {
      i++;
      continue;
    }
    let j = i;
    let totalDuration = 0;
    let allValid = true;
    while (j < segments.length && segments[j].dir !== mainDir) {
      totalDuration += segments[j].duration;
      allValid = allValid && segments[j].durationValid;
      j++;
    }
    const runLength = j - i;
    if (
      allValid &&
      runLength <= MAX_AD_SEGMENTS &&
      totalDuration <= MAX_AD_DURATION_SECONDS
    ) {
      for (let k = i; k < j; k++) {
        dropLines.add(segments[k].extinfLine);
        dropLines.add(segments[k].uriLine);
      }
    }
    i = j;
  }

  if (dropLines.size === 0) return m3u8Content;

  return lines.filter((_, idx) => !dropLines.has(idx)).join('\n');
}

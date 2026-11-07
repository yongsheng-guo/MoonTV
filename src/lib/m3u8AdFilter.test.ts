import { readFileSync } from 'fs';
import { join } from 'path';

import { filterAdsFromM3U8 } from './m3u8AdFilter';

const countMatches = (text: string, pattern: RegExp): number =>
  text.match(pattern)?.length ?? 0;

const totalDuration = (text: string): number => {
  const matches: string[] = text.match(/#EXTINF:[\d.]+/g) ?? [];
  return matches.reduce(
    (sum, m) => sum + Number.parseFloat(m.slice('#EXTINF:'.length)),
    0
  );
};

describe('filterAdsFromM3U8', () => {
  it('removes the 9 inserted ad breaks from the real ikun playlist', () => {
    const original = readFileSync(
      join(__dirname, '__tests__', 'fixtures', 'ikun-harry-potter-1.m3u8'),
      'utf8'
    );
    const filtered = filterAdsFromM3U8(original);

    // 4811 段 -> 4757 段正片，54 段广告（9 处 x 6 段）被删掉
    expect(countMatches(original, /#EXTINF:/g)).toBe(4811);
    expect(countMatches(filtered, /#EXTINF:/g)).toBe(4757);

    // 广告 URL 一段不留，正片 URL 全在
    expect(filtered).not.toContain('20261101/tkPlKg7b/10082kb');
    expect(filtered).toContain('20220928/NTAlYfF4/2000kb');

    // 全部 255 个 #EXT-X-DISCONTINUITY 标记保留，hls.js 仍能处理时间戳跳变
    expect(countMatches(filtered, /#EXT-X-DISCONTINUITY/g)).toBe(255);

    // 总时长只减少广告的 158.76 秒：9687.56 -> 9528.8
    expect(totalDuration(original)).toBeCloseTo(9687.56, 1);
    expect(totalDuration(filtered)).toBeCloseTo(9528.8, 1);

    // 结构完整：仍是 VOD 列表，带结束标记
    expect(filtered.startsWith('#EXTM3U')).toBe(true);
    expect(filtered).toContain('#EXT-X-ENDLIST');
    expect(filtered).toContain('#EXT-X-PLAYLIST-TYPE:VOD');

    // 每个 #EXTINF 后仍紧跟一个分片 URL，没有孤儿行
    const lines = filtered.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXTINF:')) {
        expect(lines[i + 1]?.trim()).toMatch(/^https?:\/\//);
      }
    }
  });

  it('removes a short foreign-directory run in a synthetic playlist', () => {
    const main = (n: number) =>
      `#EXTINF:2.0,\nhttps://cdn.example.com/movie/2000kb/seg${n}.ts`;
    const ad = (n: number) =>
      `#EXTINF:3.0,\nhttps://cdn.example.com/20261101/ad/10082kb/ad${n}.ts`;
    const original = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      ...Array.from({ length: 30 }, (_, i) => main(i)),
      '#EXT-X-DISCONTINUITY',
      ...Array.from({ length: 6 }, (_, i) => ad(i)),
      '#EXT-X-DISCONTINUITY',
      ...Array.from({ length: 30 }, (_, i) => main(100 + i)),
      '#EXT-X-ENDLIST',
    ].join('\n');

    const filtered = filterAdsFromM3U8(original);
    expect(countMatches(filtered, /#EXTINF:/g)).toBe(60);
    expect(filtered).not.toContain('/ad/');
    // 两个广告边界的 DISCONTINUITY 标记保留
    expect(countMatches(filtered, /#EXT-X-DISCONTINUITY/g)).toBe(2);
    expect(totalDuration(filtered)).toBeCloseTo(120, 5);
  });

  it('returns master playlists unchanged', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2000000,RESOLUTION=1280x716',
      '2000kb/hls/index.m3u8',
      '',
    ].join('\n');
    expect(filterAdsFromM3U8(master)).toBe(master);
  });

  it('returns ad-free playlists byte-identical', () => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4'];
    for (let i = 0; i < 40; i++) {
      if (i > 0 && i % 20 === 0) lines.push('#EXT-X-DISCONTINUITY');
      lines.push(
        '#EXTINF:2.085,',
        `https://cdn.example.com/movie/hls/s${i}.ts`
      );
    }
    lines.push('#EXT-X-ENDLIST');
    const original = lines.join('\n');
    expect(filterAdsFromM3U8(original)).toBe(original);
  });

  it('does not remove a long foreign run', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 100; i++) {
      lines.push('#EXTINF:2.0,', `https://cdn.example.com/movie/hls/s${i}.ts`);
    }
    for (let i = 0; i < 20; i++) {
      lines.push('#EXTINF:2.0,', `https://cdn.example.com/other/hls/x${i}.ts`);
    }
    const original = lines.join('\n');
    expect(filterAdsFromM3U8(original)).toBe(original);
  });

  it('does not remove a foreign run that is too long in duration', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 100; i++) {
      lines.push('#EXTINF:2.0,', `https://cdn.example.com/movie/hls/s${i}.ts`);
    }
    for (let i = 0; i < 6; i++) {
      lines.push('#EXTINF:15.0,', `https://cdn.example.com/other/hls/x${i}.ts`);
    }
    const original = lines.join('\n');
    expect(filterAdsFromM3U8(original)).toBe(original);
  });

  it('returns empty string for empty input', () => {
    expect(filterAdsFromM3U8('')).toBe('');
  });
});

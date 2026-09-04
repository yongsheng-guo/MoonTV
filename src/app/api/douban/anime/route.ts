import { NextResponse } from 'next/server';

import { getCacheTime } from '@/lib/config';
import { DoubanItem, DoubanResult } from '@/lib/types';

function fixDoubanImageUrl(url: string): string {
  if (!url) return url;
  if (!url.includes('doubanio.com')) return url;
  return url.replace(/\.(jpe?g|png)(\?.*)?$/i, (_m, _ext, query) => `.webp${query || ''}`);
}

interface DoubanAnimeApiResponse {
  data: Array<{
    id: string;
    title: string;
    rate: string;
    cover: string;
    url: string;
  }>;
}

async function fetchDoubanData(url: string): Promise<DoubanAnimeApiResponse> {
  // 添加超时控制
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

  // 设置请求选项，包括信号和头部
  const fetchOptions = {
    signal: controller.signal,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      Referer: 'https://movie.douban.com/',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://movie.douban.com',
    },
  };

  try {
    // 尝试直接访问豆瓣API
    const response = await fetch(url, fetchOptions);
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export const runtime = 'edge';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // 获取参数
  const sort = searchParams.get('sort') || 'U';
  const pageLimit = parseInt(searchParams.get('limit') || '25');
  const pageStart = parseInt(searchParams.get('start') || '0');

  // 验证参数
  if (!['U', 'T', 'S'].includes(sort)) {
    return NextResponse.json(
      { error: 'sort 参数必须是 U、T 或 S' },
      { status: 400 }
    );
  }

  if (pageLimit < 1 || pageLimit > 100) {
    return NextResponse.json(
      { error: 'pageSize 必须在 1-100 之间' },
      { status: 400 }
    );
  }

  if (pageStart < 0) {
    return NextResponse.json(
      { error: 'pageStart 不能小于 0' },
      { status: 400 }
    );
  }

  const target = `https://movie.douban.com/j/new_search_subjects?sort=${sort}&range=0,10&genres=${encodeURIComponent('动画')}&start=${pageStart}`;

  try {
    // 调用豆瓣 API
    const doubanData = await fetchDoubanData(target);

    // 转换数据格式
    const list: DoubanItem[] = (doubanData.data || []).map((item) => ({
      id: item.id,
      title: item.title,
      poster: fixDoubanImageUrl(item.cover || ''),
      rate: item.rate || '',
      year: '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: list,
    };

    const cacheTime = await getCacheTime();
    return NextResponse.json(response, {
      headers: {
        'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
        'CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
        'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}`,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: (error as Error).message },
      { status: 500 }
    );
  }
}

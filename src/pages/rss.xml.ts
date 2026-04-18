import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const articles = (await getCollection('articles', ({ data }) => !data.draft))
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  return rss({
    title: 'Legal Overflow',
    description: 'A field journal on AI and the legal profession.',
    site: context.site ?? 'https://legaloverflow.com',
    items: articles.map(a => ({
      title: a.data.title.replace(/<[^>]*>/g, ''),
      description: a.data.dek.replace(/<[^>]*>/g, ''),
      pubDate: a.data.date,
      link: `/articles/${a.slug}/`,
    })),
    customData: '<language>en-us</language>',
  });
}

import { defineCollection, z } from 'astro:content';

const articles = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    dek: z.string(),
    kind: z.string(),
    track: z.enum(['legal', 'business', 'both']),
    readMinutes: z.number(),
    date: z.date(),
    topic: z.string(),
    cover: z.enum(['ph-a', 'ph-b', 'ph-c', 'ph-d', 'ph-e', 'ph-f', 'ph-g', 'ph-h', 'ph-i', 'ph-j', 'ph-k', 'ph-l', 'ph-m']).default('ph-b'),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { articles };

import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { BrandTitle } from '@/components/brand-title';
import { gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <BrandTitle />,
      url: '/docs',
      transparentMode: 'none',
    },
    links: [
      { text: 'Repository', url: 'https://github.com/jlucasrods/QuatiBot', external: true },
      { type: 'button', text: 'Download', url: 'https://github.com/jlucasrods/QuatiBot/releases/latest', external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}

import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'handback',
  description: 'Hand control from an agent to a human, then pick it back up.',
  base: '/handback/',

  head: [
    ['link', { rel: 'icon', href: '/handback/favicon.svg', type: 'image/svg+xml' }],
  ],

  themeConfig: {
    logo: { src: '/favicon.svg', alt: 'handback' },
    siteTitle: 'handback',

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/task-format' },
      { text: 'Demo', link: '/demo.html', noIcon: true },
      { text: 'npm', link: 'https://www.npmjs.com/package/handback' },
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'Writing runbooks', link: '/guide/writing-runbooks' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Task format', link: '/reference/task-format' },
          { text: 'CLI', link: '/reference/cli' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/phin-tech/handback' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2025 Phin Tech',
    },

    editLink: {
      pattern: 'https://github.com/phin-tech/handback/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})

# Generated brand image font

`anton-subset.ts` embeds a glyph-subsetted copy of Anton Regular for the
letters used in the Ad Daddy Open Graph image and favicon. Keeping the font in
the bundle makes image rendering deterministic and avoids request-time font
downloads.

- Source: https://github.com/google/fonts/blob/main/ofl/anton/Anton-Regular.ttf
- Copyright: Copyright 2020 The Anton Project Authors
- License: SIL Open Font License 1.1 (`anton-OFL.txt`)
- Included glyphs: `A`, `D`, `Y`, and space

The subset was produced from the upstream TTF with FontTools:

```sh
pyftsubset Anton-Regular.ttf --text='ADY ' --output-file=Anton-ADY.ttf
```


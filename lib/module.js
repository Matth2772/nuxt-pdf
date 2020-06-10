import path from 'path'
import fs from 'fs'

import mkdir from 'mkdirp'
import merge from 'merge'
import puppeteer from 'puppeteer'

import chalk from 'chalk'

import {PDFDocument as Document} from 'pdf-lib'

import defaults from './module.defaults'

module.exports = function (moduleOptions) {
  const matchedRoutes = [];
  /*
   * Merge defaults and configuration from nuxt.config.js
   */
  const options = merge.recursive(
    true,
    defaults,
    moduleOptions,
    this.options.pdf
  )

  /*
   * Add pdf styling to render.
   */
  this.options.css.push(path.resolve(__dirname, 'css/pdf.css'))

  switch (options.pdf.format.toLowerCase()) {
    case 'a1':
      this.options.css.push(path.resolve(__dirname, 'css/a1.css'))
      break
    case 'a2':
      this.options.css.push(path.resolve(__dirname, 'css/a2.css'))
      break
    case 'a3':
      this.options.css.push(path.resolve(__dirname, 'css/a3.css'))
      break
    case 'a4':
      this.options.css.push(path.resolve(__dirname, 'css/a4.css'))
      break
    case 'a5':
      this.options.css.push(path.resolve(__dirname, 'css/a5.css'))
      break
    case 'letter':
      this.options.css.push(path.resolve(__dirname, 'css/letter.css'))
      break

    default:
      console.log(
        chalk.bgRed.black(' ERROR ') +
        " Unable to find format ('" +
        options.pdf.format +
        "')"
      )
      break
  }

  /*
   * Generate routes regex
   */
  options.routes = options.routes.map(r => {
    r.routeRegex = new RegExp(r.route.replace(/\*/g, "[^ ]*"));
    return r;
  })


  /*
   * Extending the generated routes with pdf requested routes.
   */
  this.nuxt.hook('generate:extendRoutes', async routes => {
    return routes.reduce((extendedRoutes, route, currentIndex, array) => {
      const routeMatches = options.routes.filter(r => route.route.match(r.routeRegex));

      if (routeMatches.length > 0) {
        const tempDir = routeMatches[0].directory.replace('___route___', route.route);
        const newDirectory = tempDir[0] === '/' ? tempDir.substring(1) : tempDir;

        matchedRoutes.push({
          ...routeMatches[0],
          directory: newDirectory,
          routeMatched: route.route,
        })
      }

      return extendedRoutes;
    }, routes);
  })

  /*
   * Generating PDF based on routes from config.
   */
  this.nuxt.hook('generate:done', async (nuxt, errors) => {
    console.log(chalk.blueBright('ℹ') + ' Generating pdf12312312s')

    for (let i = 0; i < matchedRoutes.length; i++) {
      const route = matchedRoutes[i]

      // Merge route meta with defaults from config.
      const meta = Object.assign(options.meta, route.meta)

      // Launch puppeteer headless browser.
      const browser = await puppeteer.launch(
        Object.assign(
          {
            headless: true
          },
          options.puppeteer
        )
      )

      // Create new page (new browser tab) to navigate to url.
      const page = await browser.newPage()

      const fixUrl = () => {
        const urlReplacements = options.urlReplacements.map((urlReplacement) => {
          const newUrlReplacement = JSON.parse(JSON.stringify(urlReplacement));
          newUrlReplacement[1] = newUrlReplacement[1].replace('___generateDir___', nuxt.options.generate.dir);
          return newUrlReplacement;
        });

        return (requestUrl) => {
          let match = false;

          return urlReplacements.reduce((url, urlReplacement, currentIndex, array) => {
            let finalUrl = url;

            if (!match && url.includes(urlReplacement[0])) {
              match = true;

              finalUrl = url.replace(urlReplacement[0], urlReplacement[1])
            }

            return finalUrl;
          }, requestUrl);
        }
      };

      // Navigate to the generated route.
      await page.goto(
        `file:${
          route.routeMatched === '/'
            ? path.join(nuxt.options.generate.dir, 'index.html')
            : path.join(nuxt.options.generate.dir, route.routeMatched, 'index.html')
        }`,
        {
          waitUntil: 'domcontentloaded'
        }
      )

      let inflight = 0

      await page.setRequestInterception(true);

      page.on('request', request => {
        inflight += 1
        request.continue()
      })

      page.on('requestfinished', request => {
        inflight -= 1
      })

      page.on('requestfailed', request => {
        inflight -= 1
      })

      const sleep = (timeout) => new Promise(resolve => setTimeout(resolve, timeout))
      const wait = async ({waitUntil}) => {
        const maxIdle = waitUntil === 'networkidle0' ? 0 : 2

        while (inflight > maxIdle) {
          await sleep(100)
        }
        await sleep(500)
        if (inflight > maxIdle) {
          await wait({waitUntil})
        }
      }

      await page.exposeFunction('fixUrl', fixUrl());
      await page.exposeFunction('console', console);

      await page.$$eval('img', (imgs) => {
        return imgs.map(async (img) => {
          const newSrc = await fixUrl(img.getAttribute('src'));
          img.setAttribute('src', newSrc);
          return newSrc;
        })
      })

      await page.$$eval(options.printBgClass, (elems) => {
        return elems.map(async (elem) => {
          const newSrc = await fixUrl(elem.style.backgroundImage);
          elem.style.backgroundImage = newSrc;
          return newSrc;
        })
      })

      await wait({ waitUntil: 'networkidle0' })

      // Generate pdf based on dom content. (result by bytes)
      const bytes = await page.pdf(Object.assign(options.pdf))

      // Close the browser, now that we have the pdf document.
      await browser.close()

      // Load bytes into pdf document, used for manipulating meta of file.
      const document = await Document.load(bytes)

      // Set the correct meta for pdf document.
      document.setTitle((meta.titleTemplate || '%s').replace('%s', meta.title))
      document.setAuthor(meta.author || '')
      document.setSubject(meta.subject || '')
      document.setProducer(meta.producer || '')
      document.setCreationDate(meta.creationDate || new Date())
      document.setKeywords(meta.keywords || [])

      // Create folder where file will be stored.
      mkdir(path.resolve(options.dir, route.directory))

      // Write document to file.
      const ws = fs.createWriteStream(
        path.resolve(options.dir, route.directory, route.filename)
      )
      ws.write(await document.save())
      ws.end()

      console.log(chalk.green('✔') + ' Generated ' + route.routeMatched)
    }
  })
}

module.exports.meta = require('../package.json')

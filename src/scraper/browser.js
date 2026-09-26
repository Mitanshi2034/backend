import { chromium } from 'playwright'
import { config } from '../config.js'

// One Chromium per scrape run, shared by all products in that run (each product
// gets its own fresh, isolated browser context).
export function launchBrowser({ headless = config.headless, slowMo = 0 } = {}) {
  return chromium.launch({
    headless,
    slowMo, // slows every action down, so a headed run is easy to follow on video
    args: [
      '--disable-dev-shm-usage', // Docker's /dev/shm is tiny; without this Chromium crashes on Render
    ],
  })
}

#!/usr/bin/env node
/**
 * KOFIA DIS 간이투자설명서 PDF 다운로드 스크립트
 *
 * 사용법:
 *   node download_prospectus.js --funds '<JSON>' --output '/path/to/save'
 *
 * --funds: JSON 배열 문자열 [{fundName, stdCode, company, setupDate}, ...]
 * --output: PDF 저장 디렉토리 (기본값: ./downloads/prospectus)
 *
 * n8n Execute Command 노드에서 호출됩니다.
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// ── CLI 인수 파싱 ──
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { funds: [], output: '' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--funds' && args[i + 1]) {
      parsed.funds = JSON.parse(args[i + 1]);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      parsed.output = args[i + 1];
      i++;
    }
  }

  if (!parsed.output) {
    parsed.output = path.join(process.cwd(), 'downloads', 'prospectus');
  }

  return parsed;
}

// ── 날짜 기반 하위 폴더 생성 ──
function getDateFolder(outputBase) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = kst.toISOString().slice(0, 10).replace(/-/g, '');
  const folder = path.join(outputBase, dateStr);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

// ── 파일명에 사용할 수 없는 문자 제거 ──
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
}

// ── 메인: KOFIA DIS에서 간이투자설명서 검색 및 다운로드 ──
async function downloadProspectus(funds, outputDir) {
  const saveDir = getDateFolder(outputDir);
  const results = [];

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const page = await browser.newPage();

    // PDF 다운로드를 위한 다운로드 경로 설정
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: saveDir,
    });

    // 타임아웃 설정
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(60000);

    for (const fund of funds) {
      const { fundName, stdCode, company, setupDate } = fund;
      const logPrefix = `[${company} - ${fundName}]`;

      try {
        console.error(`${logPrefix} 간이투자설명서 검색 시작...`);

        // 1. KOFIA DIS 간이투자설명서 페이지 접속
        await page.goto(
          'https://dis.kofia.or.kr/websquare/webSquare.jsp?w2xPath=/wq/fundann/DISFundSmryInvstInfo.xml',
          { waitUntil: 'networkidle2', timeout: 60000 }
        );

        // WebSquare 로딩 대기
        await page.waitForFunction(
          () => typeof WebSquare !== 'undefined' && WebSquare.isReady && WebSquare.isReady(),
          { timeout: 30000 }
        ).catch(() => {
          // WebSquare.isReady가 없는 경우 일반 대기
        });
        await delay(3000);

        // 2. 펀드명 검색 입력
        //    WebSquare 컴포넌트는 일반 DOM과 다르게 접근해야 할 수 있음
        //    펀드명 검색 필드 찾기 (일반적으로 input 요소)
        const searchInputSelector = 'input[id*="fundNm"], input[id*="FndNm"], input[id*="srch"], input[name*="fundNm"]';
        const altSearchSelector = 'input[type="text"]';

        let searchInput = await page.$(searchInputSelector);
        if (!searchInput) {
          // 모든 텍스트 입력 필드 중 적절한 것 선택
          const textInputs = await page.$$(altSearchSelector);
          if (textInputs.length > 0) {
            searchInput = textInputs[0];
          }
        }

        if (searchInput) {
          // 기존 텍스트 지우기
          await searchInput.click({ clickCount: 3 });
          await searchInput.type(fundName.substring(0, 20), { delay: 50 });
          console.error(`${logPrefix} 검색어 입력 완료`);
        } else {
          console.error(`${logPrefix} 검색 입력 필드를 찾을 수 없음. stdCode로 시도...`);

          // stdCode로 검색 시도
          const codeInput = await page.$('input[id*="stdCode"], input[id*="StdCd"], input[id*="code"]');
          if (codeInput) {
            await codeInput.click({ clickCount: 3 });
            await codeInput.type(stdCode, { delay: 50 });
          }
        }

        // 3. 검색 버튼 클릭
        const searchBtnSelector = 'button[id*="srch"], button[id*="Srch"], a[id*="srch"], input[type="button"][value*="조회"], button:has-text("조회")';
        let searchBtn = await page.$(searchBtnSelector);

        if (!searchBtn) {
          // 일반적인 조회 버튼 찾기
          searchBtn = await page.evaluateHandle(() => {
            const buttons = document.querySelectorAll('button, a, input[type="button"]');
            for (const btn of buttons) {
              const text = btn.textContent || btn.value || '';
              if (text.includes('조회') || text.includes('검색') || text.includes('Search')) {
                return btn;
              }
            }
            return null;
          });

          if (!searchBtn || !(await searchBtn.asElement())) {
            searchBtn = null;
          }
        }

        if (searchBtn) {
          await searchBtn.click();
          console.error(`${logPrefix} 조회 버튼 클릭`);
          await delay(5000);
        } else {
          // Enter 키로 검색 시도
          await page.keyboard.press('Enter');
          await delay(5000);
        }

        // 4. 검색 결과에서 펀드 찾기
        //    결과 테이블에서 매칭되는 행 클릭
        const matchFound = await page.evaluate((targetName, targetCode) => {
          // WebSquare 그리드 또는 일반 테이블에서 검색
          const rows = document.querySelectorAll('tr, div[class*="row"], div[class*="Row"]');
          for (const row of rows) {
            const text = row.textContent || '';
            if (text.includes(targetName) || (targetCode && text.includes(targetCode))) {
              // 간이투자설명서 관련 링크/버튼 클릭
              const links = row.querySelectorAll('a, button, span[onclick], td[onclick]');
              for (const link of links) {
                const linkText = link.textContent || '';
                if (linkText.includes('간이') || linkText.includes('PDF') || linkText.includes('다운')) {
                  link.click();
                  return 'clicked_download';
                }
              }
              // 행 자체 클릭 (상세보기로 이동)
              const firstLink = row.querySelector('a');
              if (firstLink) {
                firstLink.click();
                return 'clicked_detail';
              }
              row.click();
              return 'clicked_row';
            }
          }
          return null;
        }, fundName, stdCode);

        if (!matchFound) {
          console.error(`${logPrefix} 검색 결과에서 펀드를 찾을 수 없음`);
          results.push({
            fundName,
            stdCode,
            company,
            status: 'not_found',
            message: '검색 결과에서 펀드를 찾을 수 없음',
          });
          continue;
        }

        console.error(`${logPrefix} 매칭 결과 발견: ${matchFound}`);
        await delay(3000);

        // 5. 상세페이지에서 PDF 다운로드 링크 찾기
        if (matchFound === 'clicked_detail' || matchFound === 'clicked_row') {
          // 상세 페이지에서 간이투자설명서 PDF 다운로드 버튼 찾기
          const downloadClicked = await page.evaluate(() => {
            const elements = document.querySelectorAll('a, button, span, input[type="button"]');
            for (const el of elements) {
              const text = el.textContent || el.value || '';
              if (
                text.includes('간이투자설명서') ||
                text.includes('PDF') ||
                text.includes('다운로드') ||
                text.includes('Download')
              ) {
                el.click();
                return true;
              }
            }
            // fileDownLoad 함수 직접 호출 시도
            if (typeof fileDownLoad === 'function') {
              return 'fileDownLoad_available';
            }
            return false;
          });

          if (downloadClicked) {
            console.error(`${logPrefix} PDF 다운로드 시작`);
            await delay(5000);
          }
        }

        // 6. 다운로드 완료 확인 및 파일명 변경
        const downloadedFiles = fs.readdirSync(saveDir).filter((f) => f.endsWith('.pdf'));
        const latestFile = downloadedFiles
          .map((f) => ({
            name: f,
            time: fs.statSync(path.join(saveDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.time - a.time)[0];

        if (latestFile) {
          const newName = sanitizeFilename(
            `간이투자설명서_${company}_${fundName}_${setupDate || 'unknown'}.pdf`
          );
          const oldPath = path.join(saveDir, latestFile.name);
          const newPath = path.join(saveDir, newName);

          if (oldPath !== newPath) {
            fs.renameSync(oldPath, newPath);
          }

          results.push({
            fundName,
            stdCode,
            company,
            status: 'success',
            filePath: newPath,
          });
          console.error(`${logPrefix} 다운로드 완료: ${newPath}`);
        } else {
          // PDF가 다운로드되지 않은 경우, 페이지 내 iframe/embed PDF 확인
          const pdfUrl = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[src*=".pdf"], embed[src*=".pdf"]');
            if (iframe) return iframe.src;
            const objects = document.querySelectorAll('object[data*=".pdf"]');
            if (objects.length > 0) return objects[0].data;
            return null;
          });

          if (pdfUrl) {
            console.error(`${logPrefix} PDF URL 발견: ${pdfUrl}`);
            const viewSource = await page.goto(pdfUrl);
            const pdfBuffer = await viewSource.buffer();
            const pdfFilename = sanitizeFilename(
              `간이투자설명서_${company}_${fundName}_${setupDate || 'unknown'}.pdf`
            );
            const pdfPath = path.join(saveDir, pdfFilename);
            fs.writeFileSync(pdfPath, pdfBuffer);
            results.push({
              fundName,
              stdCode,
              company,
              status: 'success',
              filePath: pdfPath,
            });
            console.error(`${logPrefix} PDF 저장 완료: ${pdfPath}`);
          } else {
            results.push({
              fundName,
              stdCode,
              company,
              status: 'download_failed',
              message: 'PDF 파일을 찾거나 다운로드할 수 없음',
            });
            console.error(`${logPrefix} PDF 다운로드 실패`);
          }
        }
      } catch (err) {
        console.error(`${logPrefix} 오류: ${err.message}`);
        results.push({
          fundName,
          stdCode,
          company,
          status: 'error',
          message: err.message,
        });
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 실행 ──
async function main() {
  const { funds, output } = parseArgs();

  if (funds.length === 0) {
    console.error('다운로드할 펀드가 없습니다.');
    console.log(JSON.stringify({ results: [], message: '펀드 데이터 없음' }));
    process.exit(0);
  }

  console.error(`총 ${funds.length}개 펀드의 간이투자설명서 다운로드 시작`);
  console.error(`저장 경로: ${output}`);

  try {
    const results = await downloadProspectus(funds, output);
    const successCount = results.filter((r) => r.status === 'success').length;
    console.error(`\n완료: ${successCount}/${funds.length}개 다운로드 성공`);

    // n8n으로 결과 전달 (stdout에 JSON 출력)
    console.log(JSON.stringify({ results, saveDir: output }));
  } catch (err) {
    console.error('치명적 오류:', err.message);
    console.log(JSON.stringify({ results: [], error: err.message }));
    process.exit(1);
  }
}

main();

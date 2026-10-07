---
name: office-docs
description: 엑셀(xlsx)·워드(docx)·PPT(pptx) 문서를 만들 때, 그리고 첨부된 엑셀·워드·CSV 를 읽을 때의 방법. 파이썬(openpyxl·python-docx)을 실행하고 결과는 파일함/ 에 저장한다. "보고서 만들어 줘", "엑셀로 정리해 줘", "워드 문서로 뽑아 줘" 같은 요청이 오면 먼저 이 문서를 따른다.
---

# 문서 만들기 (office-docs)

만든 문서는 `파일함/` 에 저장한다. 그러면 화면이 채팅에 **파일 카드(보기·열기·⬇ 받기)** 를 알아서 띄운다. 경로나 내려받는 법을 길게 설명하지 않는다.

## 시작하기 전에 (꼭 이 순서로)

1. **실행 도구가 있는지 본다.** 파이썬을 돌리려면 Bash(윈도우는 PowerShell도) 도구가 필요하다. 이 도구는 주인이 설정 → 권한 → **명령 실행** 을 켰을 때만 있다.
   도구가 없으면 문서를 만들 수 없다. "설정 → 권한에서 '명령 실행'을 켜 주세요"라고 알리고 멈춘다. 스스로 켜려 하지 않는다.
2. **`python`** 으로 실행한다. **`python3` 는 이 PC 에서 멈추니 절대 쓰지 않는다.**
   - `python` 이 없다고 나오면(`command not found`, `Python was not found`, 종료 코드 9009) 파이썬 설치가 필요하다고 알리고 멈춘다: "python.org 에서 파이썬을 설치하고 설치 첫 화면의 'Add python.exe to PATH' 를 체크해 주세요." 스스로 설치하지 않는다.
3. 쓸 라이브러리가 있는지 먼저 확인한다: `python -c "import openpyxl, docx; print('ok')"`
   - 엑셀 = **openpyxl**, 워드 = **python-docx** (`import docx`). 이 PC 에 있다.
   - PPT 는 **python-pptx** 가 필요한데 **이 PC 에는 없다** (`python -c "import pptx"` 로 확인).
4. **없는 라이브러리는 마음대로 설치하지 않는다.** `pip install` 을 실행하지 않는다. 대신 주인에게 설치 방법을 알려 준다:
   > PPT 를 만들려면 python-pptx 가 필요해요. 명령 창에서 `python -m pip install python-pptx` 를 실행한 뒤 다시 말씀해 주세요.
   그리고 지금 바로 할 수 있는 대안(워드로 개요 문서, 엑셀 표)을 한 줄로 제안한다.

## 파일 위치와 이름

- 만든 문서: `파일함/<알아보기 쉬운 이름>.docx` (작업 폴더 기준). 한글 이름 가능. 예: `열교환기_지연작업_보고.docx`
- 같은 이름이 이미 있으면 **덮어쓰지 않는다.** 이름 뒤에 `_2`, `_3` 을 붙인다 (`os.path.exists` 로 확인).
- 파이썬 스크립트는 `작업/make_<무엇>.py` 로 **Write 도구로 쓰고** 실행한다. 일회용이라 파일함에 두지 않는다. `python -c "…"` 로 길게 한 줄에 쓰지 않는다.
- 첨부 파일은 `uploads/` 에 있다. 읽기만 하고 고치지 않는다.

## 실행

```
python 작업/make_report.py
```

- 스크립트 맨 위에 `import sys; sys.stdout.reconfigure(encoding='utf-8')` 를 넣는다 (한글을 출력할 때 윈도우에서 오류가 나는 것을 막는다).
- 한 번에 하나씩: 스크립트 쓰기 → 실행 → 결과 확인. 오류가 나면 메시지를 읽고 스크립트를 고쳐 다시 실행한다.
- **같은 오류로 두 번 실패하면 멈추고** 무엇이 안 되는지 주인에게 쉬운 말로 알린다 (끝없이 다시 시도하지 않는다).
- 스크립트는 입력을 기다리지 않게 쓴다 (`input()` 금지). 실행이 1분 넘게 끝나지 않으면 멈췄다고 보고 알린다.
- 저장할 때 `PermissionError` 가 나면 그 파일이 워드·엑셀에 열려 있는 것이다. 다른 이름(`_2`)으로 저장한다.

## 읽기 (첨부된 파일)

- **CSV**: Read 도구로 바로 읽힌다. 엑셀에서 저장한 CSV 는 맨 앞에 BOM 이 있다 → 파이썬은 `open(경로, encoding='utf-8-sig', newline='')` + `csv.DictReader`.
- **공정표 CSV** (화면의 WBS → 📊 엑셀로 내보낸 파일): 첫 줄 칸 이름은 `코드,단계,작업명,담당,시작일,완료일,가중치,진도율(%),계획 진도(%),상태,메모`.
  - `코드` 칸은 엑셀이 `1.1` 을 날짜로 바꾸지 않게 **`="1.1"` 모양**으로 들어 있다. 문서·표에 쓸 때는 `re.sub(r'^="(.*)"$', r'\1', 값)` 로 `1.1` 로 바꾼다. (그대로 쓰면 표에 `="1.1"` 이 찍힌다)
  - 글 칸(작업명·담당·메모)이 `= + - @` 로 시작하면 엑셀 보호용으로 앞에 작은따옴표(`'`)가 붙어 있다. 떼고 쓴다.
  - `단계` 는 `대단락`(묶음)·`작업`. `상태` 는 완료·진행·지연·대기. "지연된 작업" = `단계` 가 작업이고 `상태` 가 지연인 행. 진도율 − 계획 진도가 음수면 계획보다 늦은 것이다.
- **엑셀**: `openpyxl.load_workbook(경로, data_only=True)` → `ws.iter_rows(values_only=True)`
- **워드**: `docx.Document(경로)` → `doc.paragraphs`, `doc.tables`
- 이미지·PDF 는 Read 도구로 읽는다.

## 워드 만들기 (python-docx)

한글 글꼴을 지정해야 한다. 안 하면 한글이 엉뚱한 글꼴로 나온다. 제목 스타일도 같이 지정한다.

```python
import sys; sys.stdout.reconfigure(encoding='utf-8')
import os
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

FONT = '맑은 고딕'
doc = Document()
for name in ['Normal', 'Title', 'Heading 1', 'Heading 2', 'Heading 3']:
    st = doc.styles[name]
    st.font.name = FONT                                  # 먼저 이름을 정해야 아래 eastAsia 칸이 생긴다
    st.element.rPr.rFonts.set(qn('w:eastAsia'), FONT)    # 한글 글꼴
doc.styles['Normal'].font.size = Pt(10.5)

def shade(cell, fill='D9E2F3'):                          # 표 머리글 배경색
    pr = cell._tc.get_or_add_tcPr(); shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear'); shd.set(qn('w:color'), 'auto'); shd.set(qn('w:fill'), fill); pr.append(shd)

doc.add_heading('제목', level=1)
doc.add_paragraph('기준일: 2026-10-07')
head = ['코드', '작업명', '담당']
rows = [['3.2', '튜브 삽입·확관', '박마바']]
t = doc.add_table(rows=1, cols=len(head)); t.style = 'Table Grid'
for i, h in enumerate(head):
    c = t.rows[0].cells[i]; c.text = h; shade(c)
    for r in c.paragraphs[0].runs: r.bold = True
for row in rows:
    cells = t.add_row().cells
    for i, v in enumerate(row): cells[i].text = str(v)

path = '파일함/보고.docx'
n = 2
while os.path.exists(path):                              # 덮어쓰지 않는다
    path = f'파일함/보고_{n}.docx'; n += 1
doc.save(path); print('saved', path)
```

**보고용 문서 짜임**: 제목 → 기준일·작성일(오늘 날짜) → 한 문단 요약(몇 건·가장 큰 문제) → 표(꼭 필요한 칸만) → 확인·조치 사항.
내용은 **첨부 자료에 있는 사실만** 쓴다. 지어내지 않고, 모르는 것은 `확인 필요`라고 적는다. 시킨 만큼만 쓴다.

## 엑셀 만들기 (openpyxl)

```python
import sys; sys.stdout.reconfigure(encoding='utf-8')
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

wb = Workbook(); ws = wb.active; ws.title = '정리'
ws.append(['코드', '작업명', '진도율(%)'])
for c in ws[1]: c.font = Font(bold=True); c.fill = PatternFill('solid', fgColor='D9E2F3')
ws.append(['3.2', '튜브 삽입·확관', 70])
ws.column_dimensions['B'].width = 30
ws.freeze_panes = 'A2'
wb.save('파일함/정리.xlsx')
```

- 수식(`=SUM(C2:C9)`)은 글자로 넣는다. 파이썬은 계산하지 않고 엑셀이 열 때 계산한다 (화면의 "보기"에는 수식 글자로 보인다).
- 숫자는 숫자로 넣는다 (문자열 `"70"` 이 아니라 `70`).

## PPT

python-pptx 가 있을 때만 만든다 (`python -c "import pptx"` 가 성공할 때). 없으면 위 "시작하기 전에" 의 4번처럼 설치 방법만 알려 준다.

## 마무리

1. 만든 파일을 다시 열어 확인한다: 워드는 `Document(경로)` 로 문단 수·표 수, 엑셀은 `load_workbook(경로)` 로 시트·행 수.
2. 답에는 **무엇을 만들었는지만** 한두 줄: 파일 이름, 표가 몇 개인지, 핵심 숫자. (파일 카드는 화면이 띄운다)
3. 만든 파일을 메일로 보내거나 밖으로 내보내지 않는다.

// doc: docs/harness/ui.md
import { el } from './dom.js'

/**
 * Syntax colouring for code the window shows: fenced blocks in an answer and
 * the lines of a diff. It reads tokens one after another and builds no
 * syntax tree. It finds comments, strings, numbers, keywords and the words
 * around them, which is most of what makes code readable at a glance, and it
 * builds text nodes only, so nothing a model writes is ever read as markup.
 */

export interface Grammar {
  keywords: ReadonlySet<string>
  /** Words that stand for a value: true, null, None. */
  literals: ReadonlySet<string>
  lineComments: readonly string[]
  blockComment?: readonly [string, string]
  /** Characters that open a string closed by the same character. */
  quotes: string
  /** Quotes that may run across lines. */
  multiline: string
  /** Delimiters that open a string closed by the same delimiter, across lines. */
  longQuotes: readonly string[]
  /** Keywords match whatever their case, as SQL's do. */
  anyCase: boolean
  /** `<name` and `</name` are tags. */
  tags: boolean
}

function words(list: string): ReadonlySet<string> {
  return new Set(list.split(' '))
}

function grammar(parts: Partial<Grammar>): Grammar {
  return {
    keywords: new Set(),
    literals: new Set(),
    lineComments: [],
    quotes: '"\'',
    multiline: '',
    longQuotes: [],
    anyCase: false,
    tags: false,
    ...parts,
  }
}

const SCRIPT = grammar({
  keywords: words(
    'abstract as async await break case catch class const continue debugger declare default delete do else enum export ' +
      'extends finally for from function get if implements import in infer instanceof interface is keyof let namespace new ' +
      'of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield',
  ),
  literals: words('true false null undefined NaN Infinity'),
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: '"\'`',
  multiline: '`',
})

const PYTHON = grammar({
  keywords: words(
    'and as assert async await break case class continue def del elif else except finally for from global if import in is ' +
      'lambda match nonlocal not or pass raise return try while with yield',
  ),
  literals: words('True False None self cls'),
  lineComments: ['#'],
  longQuotes: ['"""', "'''"],
})

const RUST = grammar({
  keywords: words(
    'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref ' +
      'return static struct super trait type unsafe use where while',
  ),
  literals: words('true false self Self None Some Ok Err'),
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: '"',
})

const GO = grammar({
  keywords: words(
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package range ' +
      'return select struct switch type var',
  ),
  literals: words('true false nil iota'),
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: '"\'`',
  multiline: '`',
})

/** C and the languages that took its syntax: C++, Java, C#, Kotlin, Swift, Scala. */
const C_LIKE = grammar({
  keywords: words(
    'abstract auto bool break case catch char class const continue default do double else enum extern final float for fun ' +
      'func goto guard if implements import inline int interface let long namespace new object override package private ' +
      'protected public return short signed sizeof static struct switch template this throw throws try typedef typename union ' +
      'unsigned using val var virtual void volatile when while',
  ),
  literals: words('true false null nullptr NULL nil'),
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
})

const SHELL = grammar({
  keywords: words(
    'if then else elif fi for while until do done case esac in function return export local readonly unset set shift exit ' +
      'source alias echo cd',
  ),
  lineComments: ['#'],
  multiline: '"\'',
})

const POWERSHELL = grammar({
  keywords: words('function param if else elseif foreach for while do return try catch finally throw switch begin process end in'),
  literals: words('$true $false $null'),
  lineComments: ['#'],
  blockComment: ['<#', '#>'],
  multiline: '"\'',
})

const JSON_DATA = grammar({
  literals: words('true false null'),
  // Comments are not JSON, and the tsconfig and settings files people paste carry them anyway.
  lineComments: ['//'],
  blockComment: ['/*', '*/'],
  quotes: '"',
})

const YAML = grammar({ literals: words('true false null yes no on off ~'), lineComments: ['#'] })

const INI = grammar({ literals: words('true false'), lineComments: ['#', ';'] })

const CSS = grammar({ keywords: words('@media @import @keyframes @font-face @supports @layer @container'), blockComment: ['/*', '*/'] })

const SQL = grammar({
  keywords: words(
    'select from where insert into values update set delete create table index view drop alter add column join left right ' +
      'inner outer full cross on group by order having limit offset as and or not is in exists between like union all ' +
      'distinct primary key foreign references default case when then else end with returning asc desc',
  ),
  literals: words('null true false'),
  lineComments: ['--'],
  blockComment: ['/*', '*/'],
  quotes: '\'"',
  anyCase: true,
})

// Only double quotes: an apostrophe in the text between tags is not a string.
const MARKUP = grammar({ blockComment: ['<!--', '-->'], tags: true, quotes: '"', multiline: '"' })

const GRAMMARS: Record<string, Grammar> = {}
const NAMES: [Grammar, string][] = [
  [SCRIPT, 'js jsx mjs cjs javascript ts tsx mts cts typescript'],
  [PYTHON, 'py pyi python'],
  [RUST, 'rs rust'],
  [GO, 'go golang'],
  [C_LIKE, 'c h cc cpp cxx hpp hh c++ java cs csharp kt kts kotlin swift scala'],
  [SHELL, 'sh bash zsh fish shell console shellscript makefile dockerfile'],
  [POWERSHELL, 'ps1 psm1 powershell pwsh'],
  [JSON_DATA, 'json jsonc json5'],
  [YAML, 'yaml yml'],
  [INI, 'toml ini cfg conf env properties'],
  [CSS, 'css scss sass less'],
  [SQL, 'sql'],
  [MARKUP, 'html htm xml svg vue'],
]
for (const [rules, names] of NAMES) for (const name of names.split(' ')) GRAMMARS[name] = rules

/** The rules for a fence's language tag, or null for a language this does not colour. */
export function grammarFor(language: string): Grammar | null {
  return GRAMMARS[language.toLowerCase()] ?? null
}

/** The language a file is written in, by its extension or, for the few that have none, its name. */
export function languageOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(dot + 1)
}

const WORD = /[A-Za-z_$@][\w$]*/y
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]*/y
const TAG = /<\/?[A-Za-z][\w:.-]*/y

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\w$]/.test(char)
}

/** Where a string that opened at `start` ends, past its closing quote or at the end of the line it could not leave. */
function stringEnd(code: string, start: number, quote: string, multiline: boolean): number {
  let i = start + quote.length
  while (i < code.length) {
    if (code.startsWith(quote, i)) return i + quote.length
    const char = code[i]
    if (char === '\n' && !multiline) return i
    i += char === '\\' ? 2 : 1
  }
  return code.length
}

/**
 * `code` as coloured spans and plain text, ready to put in a `<code>`. With no
 * grammar it is one text node.
 */
export function highlight(code: string, rules: Grammar | null): DocumentFragment {
  const out = document.createDocumentFragment()
  if (rules === null) {
    out.append(code)
    return out
  }
  let plain = ''
  const token = (kind: string, text: string): void => {
    if (plain !== '') out.append(plain)
    plain = ''
    out.append(el('span', `tok-${kind}`, text))
  }

  let i = 0
  while (i < code.length) {
    const char = code[i] ?? ''
    const line = rules.lineComments.find(mark => code.startsWith(mark, i))
    if (line !== undefined) {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      token('com', code.slice(i, stop))
      i = stop
      continue
    }
    const block = rules.blockComment
    if (block !== undefined && code.startsWith(block[0], i)) {
      const end = code.indexOf(block[1], i + block[0].length)
      const stop = end === -1 ? code.length : end + block[1].length
      token('com', code.slice(i, stop))
      i = stop
      continue
    }
    const long = rules.longQuotes.find(mark => code.startsWith(mark, i))
    if (long !== undefined) {
      const stop = stringEnd(code, i, long, true)
      token('str', code.slice(i, stop))
      i = stop
      continue
    }
    if (rules.quotes.includes(char)) {
      const stop = stringEnd(code, i, char, rules.multiline.includes(char))
      token('str', code.slice(i, stop))
      i = stop
      continue
    }
    if (rules.tags && char === '<') {
      TAG.lastIndex = i
      const tag = TAG.exec(code)
      if (tag !== null) {
        token('tag', tag[0])
        i += tag[0].length
        continue
      }
    }
    if (/\d/.test(char) && !isWordChar(code[i - 1])) {
      NUMBER.lastIndex = i
      const number = NUMBER.exec(code)
      if (number !== null) {
        token('num', number[0])
        i += number[0].length
        continue
      }
    }
    if (/[A-Za-z_$@]/.test(char) && !isWordChar(code[i - 1])) {
      WORD.lastIndex = i
      const word = WORD.exec(code)?.[0] ?? char
      const key = rules.anyCase ? word.toLowerCase() : word
      if (rules.keywords.has(key)) token('kw', word)
      else if (rules.literals.has(key)) token('lit', word)
      else if (/^\s*\(/.test(code.slice(i + word.length, i + word.length + 8))) token('fn', word)
      else if (/^[A-Z][a-z]/.test(word)) token('type', word)
      else plain += word
      i += word.length
      continue
    }
    plain += char
    i += 1
  }
  if (plain !== '') out.append(plain)
  return out
}

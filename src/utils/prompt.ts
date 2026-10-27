import confirm from '@inquirer/confirm'
import input from '@inquirer/input'
import password from '@inquirer/password'
import select from '@inquirer/select'

const prompts: Record<string, (config: any) => Promise<any>> = { confirm, input, password, select }

/**
 * Minimal stand-in for inquirer's legacy `prompt([...questions])`, covering what this CLI
 * asks: input/password/confirm/select questions with default, choices, validate, filter
 * and when. Using the single @inquirer prompts instead of the `inquirer` bundle keeps the
 * editor prompt (and its iconv-lite/safer-buffer chain) out of the dependency tree.
 */
export async function prompt (questions: any[]): Promise<Record<string, any>> {
  const answers: Record<string, any> = {}
  for (const { type = 'input', name, when, filter, ...config } of questions) {
    if (typeof when === 'function' ? !(await when(answers)) : when === false) continue
    const value = await prompts[type](config)
    answers[name] = filter ? await filter(value, answers) : value
  }
  return answers
}

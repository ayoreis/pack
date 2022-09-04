import { inverse } from 'https://deno.land/std@0.153.0/fmt/colors.ts'
import { pack } from './mod.ts'

Deno.test('Bundler', async () => {
	const output = await pack('./fixtures/mod1.ts')
	console.log(inverse(`✅ ${output}`))
	new Function(output)()
})

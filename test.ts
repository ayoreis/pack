import { inverse } from 'https://deno.land/std@0.153.0/fmt/colors.ts'
import { pack } from './mod.ts'

const AsyncFunction = async function () {}.constructor

Deno.test('Packer', async task => {
	let output: string

	await task.step('Pack', async () => {
		output = await pack('./mod.ts', {
			customResolvers: [console.log],
		})
	})

	await task.step('Print', () => {
		console.log(inverse(`✅ ${output}`))
	})

	await task.step('Run', async () => {
		await AsyncFunction(output)()
	})
})

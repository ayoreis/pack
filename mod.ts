import {
	ErrorStackParser,
	swc,
	fromJs,
	JSXPlugin,
	stage3Plugin,
	toJs,
	JSXHandler,
} from './dependencies.ts'

type Location = string | URL
type MaybePromise<T> = Promise<T> | T

type Resolver = (
	imported: Location,
	importer: Location,
) => MaybePromise<string | void>

interface Options {
	customResolvers?: Resolver[]
	outputFormat?: 'iife'
	resolveDirectory?: Location
}
/** `string` because searching/comparing URLs (different objects) doesn't work. */
type DependencyCache = Map<string, Module>

class Module {
	filepath!: Location
	importer!: Location
	customResolvers!: Resolver[]
	dependencyCache!: DependencyCache
	absoluteFilepath!: URL
	content!: string
	ast!: any
	dependencies!: Module[]

	constructor(
		filepath: Location,
		importer: Location,
		customResolvers: Resolver[] = [],
		dependencyCache: DependencyCache,
	) {
		return (async () => {
			if (dependencyCache.has(locationToString(filepath))) {
				return dependencyCache.get(locationToString(filepath))
			}

			this.filepath = filepath
			this.importer = importer
			this.customResolvers = customResolvers
			this.dependencyCache = dependencyCache
			this.absoluteFilepath = new URL(filepath, importer)

			this.content = await this.handleRequest(
				this.filepath,
				this.importer,
			)

			this.ast = fromJs(
				this.content,

				{
					module: true,
					plugins: [JSXPlugin(), stage3Plugin],
				},
			)

			this.dependencies = await this.findDependencies()

			dependencyCache.set(locationToString(this.absoluteFilepath), this)

			return this
		})() as unknown as Module
	}

	async findDependencies(): Promise<Module[]> {
		return await Promise.all(
			this.ast.body
				.filter(
					node =>
						(node.type === 'ImportDeclaration' ||
							node.type === 'ExportNamedDeclaration' ||
							node.type === 'ExportDefaultDeclaration' ||
							node.type === 'ExportAllDeclaration') &&
						node.source,
				)
				.map(
					async node =>
						await new Module(
							node.source.value,
							this.absoluteFilepath,
							this.customResolvers,
							this.dependencyCache,
						),
				),
		)
	}

	resolveRelativePath(
		relativePath: Location,
		importer: Location = this.absoluteFilepath,
	) {
		return new URL(relativePath, importer)
	}

	async handleRequest(filepath: Location, importer: Location) {
		for (const customResolver of this.customResolvers) {
			const resolvedRequest = await customResolver(
				locationToString(filepath),
				locationToString(importer),
			)

			if (typeof resolvedRequest !== 'undefined') return resolvedRequest
		}

		return await (
			await fetch(this.resolveRelativePath(filepath, importer))
		).text()
	}

	transformModuleInterface() {
		const exports: string[] = []

		for (const [index, node] of Object.entries(this.ast.body)) {
			if (node.type === 'ImportDeclaration') {
				const imports: string[] = []
				let namespaceImport: string

				for (const specifier of node.specifiers) {
					if (
						specifier.type === 'ImportSpecifier' ||
						specifier.type === 'ImportDefaultSpecifier'
					) {
						const imported =
							specifier.imported?.name ??
							(specifier.imported?.value &&
								`'${specifier.imported?.value}'`) ??
							'default'

						const onlyNeedsImported =
							specifier.local.name === imported

						imports.push(
							onlyNeedsImported
								? imported
								: `${imported}: ${specifier.local.name}`,
						)
					} else if (specifier.type === 'ImportNamespaceSpecifier') {
						namespaceImport = specifier.local.name
					}
				}

				// TODO Make import of namespace and default value possible simultaneously.
				this.ast.body[index] = fromJs(
					`const ${
						namespaceImport ?? `{ ${imports.join()} }`
					} = importModule('${this.resolveRelativePath(
						node.source.value,
					)}')`,
					{ plugins: [JSXPlugin(), stage3Plugin] },
				).body[0]
			} else if (node.type === 'ExportNamedDeclaration') {
				if (node.declaration) {
					this.ast.body[index] = node.declaration

					if (node.declaration.type === 'VariableDeclaration') {
						// TODO Destructures: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/export#:~:text=export%20const%20%7B%20name1%2C%20name2%3A%20bar%20%7D%20%3D%20o%3B%0Aexport%20const%20%5B%20name1%2C%20name2%20%5D%20%3D%20array%3B.
						exports.push(
							...node.declaration.declarations.map(
								declaration => declaration.id.name,
							),
						)
					} else if (
						node.declaration.type === 'FunctionDeclaration' ||
						node.declaration.type === 'ClassDeclaration'
					) {
						exports.push(node.declaration.id.name)
					}
				} else {
					this.ast.body.pop(index)

					const specifiers: string[] = []
					const external = !!node.source

					for (const specifier of node.specifiers) {
						const exported =
							specifier.exported?.name ??
							(specifier.exported?.value &&
								`'${specifier.exported?.value}'`)

						const onlyNeedsLocal = specifier.local.name === exported

						specifiers.push(
							external
								? `'${exported}': '${specifier.local.name}'`
								: onlyNeedsLocal
								? specifier.local.name
								: `${exported}: ${specifier.local.name}`,
						)
					}

					exports.push(
						external
							? `...importModule('${this.resolveRelativePath(
									node.source.value,
							  )}', {${specifiers.join()}})`
							: specifiers.join(),
					)
				}
			} else if (node.type === 'ExportDefaultDeclaration') {
				this.ast.body.pop(index)

				exports.push(
					`default: ${
						toJs(
							{
								type: 'Program',
								body: [node.declaration],
								sourceType: 'module',
							},
							{ handlers: JSXHandler },
						).value
					}`,
				)
			} else if (node.type === 'ExportAllDeclaration') {
				// TODO remove default from import all and import all as.
				this.ast.body.pop(index)

				const exported =
					node.exported?.name ??
					(node.exported?.value && `'${node.exported?.value}'`)

				exports.push(
					`${
						node.exported ? `${exported}: ` : '...'
					}importModule('${this.resolveRelativePath(
						node.source.value,
					)}')`,
				)
			}
		}

		this.ast.body.push(
			fromJs(`return {${exports.join()}}`, {
				allowReturnOutsideFunction: true,
				plugins: [JSXPlugin(), stage3Plugin],
			}).body[0],
		)

		this.content = toJs(this.ast, { handlers: JSXHandler }).value
	}
}

const locationToString = (maybeURL: Location): string =>
	maybeURL instanceof URL ? maybeURL.href : maybeURL

async function createDependencyGraph(
	filepath: Location,
	importer: Location,
	customResolvers: Resolver[] = [],
) {
	const dependencyCache: DependencyCache = new Map()

	const rootModule = await new Module(
		filepath,
		importer,
		customResolvers,
		dependencyCache,
	)

	return rootModule
}

function collectModules(graph: Module) {
	const modules = new Set<Module>()

	function collect(module: Module, modules: Set<Module>) {
		if (!modules.has(module)) {
			modules.add(module)

			module.dependencies.forEach(dependency =>
				collect(dependency, modules),
			)
		}
	}

	collect(graph, modules)

	return Array.from(modules)
}

function toModuleMap(modules: Module[]) {
	const moduleMap = `{${modules
		.map(module => {
			module.transformModuleInterface()
			return `async '${module.absoluteFilepath}'() {${module.content}},`
		})
		.join('')}}`

	return moduleMap
}

export async function pack(
	filepath: Location,

	{
		customResolvers = [],
		resolveDirectory = ErrorStackParser.parse(new Error())[1].fileName,
	}: Options = {},
) {
	const graph = await createDependencyGraph(
		filepath,
		resolveDirectory,
		customResolvers,
	)

	const { absoluteFilepath } = graph
	const modules = collectModules(graph)
	const moduleMap = toModuleMap(modules)

	const template = `const EXPORTS_CACHE = new Map()
    const MODULES = ${moduleMap}

    async function importModule(moduleName, pick) {
        if (!EXPORTS_CACHE.has(moduleName)) {
        	EXPORTS_CACHE.set(moduleName, await MODULES[moduleName]())
        }

		const exportsCache = EXPORTS_CACHE.get(moduleName)

        return Object.fromEntries(
			Object.entries(pick).map(([name, rename]) => {
				return [rename, exportsCache(name)]
			})
		)
    }

    await importModule('${absoluteFilepath}')`

	return template
}

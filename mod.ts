import {
	ErrorStackParser,
	fromJs,
	JSXPlugin,
	stage3Plugin,
	toJs,
	JSXHandler,
} from './dependencies.ts'

type Location = string | URL
/** `string` because comparing URLs (objects) doesn't work. */
type ModuleCache = Map<string, Module>

class Module {
	content!: string
	filepath!: Location
	moduleCache!: ModuleCache
	ast!: any
	dependencies!: Module[]

	constructor(filepath: Location, moduleCache: ModuleCache) {
		return (async () => {
			if (moduleCache.has(URLToString(filepath))) {
				return moduleCache.get(URLToString(filepath))
			}

			this.filepath = filepath
			this.moduleCache = moduleCache
			this.content = await (await fetch(this.filepath)).text()

			this.ast = fromJs(this.content, {
				module: true,
				plugins: [JSXPlugin(), stage3Plugin],
			})

			this.dependencies = await this.findDependencies()

			moduleCache.set(URLToString(this.filepath), this)

			return this
		})() as unknown as Module
	}

	async findDependencies(): Promise<Module[]> {
		return await Promise.all(
			this.ast.body // TODO Dependecies also come from `export ... from`s.
				.filter(node => node.type === 'ImportDeclaration')
				.map(node => node.source.value)
				.map(relativePath => this.resolveRequest(relativePath))
				.map(
					async absolutePath =>
						await new Module(absolutePath, this.moduleCache),
				),
		)
	}

	resolveRequest(importedPath: Location) {
		return new URL(importedPath, this.filepath)
	}

	transformModuleInterface() {
		let exports = ''

		for (const [index, node] of Object.entries(this.ast.body)) {
			if (node.type === 'ImportDeclaration') {
				let imports = ''
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

						imports +=
							(onlyNeedsImported
								? imported
								: `${imported}: ${specifier.local.name}`) + ','
					} else if (specifier.type === 'ImportNamespaceSpecifier') {
						namespaceImport = specifier.local.name
					}
				}

				// TODO Make import of namespace and default value possible simultaneously.
				this.ast.body[index] = fromJs(
					`const ${
						namespaceImport ?? `{ ${imports} }`
					} = importModule('${this.resolveRequest(
						node.source.value,
					)}')`,
					{ plugins: [JSXPlugin(), stage3Plugin] },
				).body[0]
			} else if (node.type === 'ExportNamedDeclaration') {
				if (node.declaration) {
					this.ast.body[index] = node.declaration

					if (node.declaration.type === 'VariableDeclaration') {
						// TODO Destructures.
						exports +=
							node.declaration.declarations
								.map(declaration => declaration.id.name)
								.join(',') + ','
					} else if (
						node.declaration.type === 'FunctionDeclaration' ||
						node.declaration.type === 'ClassDeclaration'
					) {
						// TODO ?
						this.ast.body.pop(index)
						exports += `${node.declaration.id.name},`
					}
				} else {
					this.ast.body.pop(index)

					let specifiers = ''

					for (const specifier of node.specifiers) {
						const exported =
							specifier.exported?.name ??
							(specifier.exported?.value &&
								`'${specifier.exported?.value}'`)

						const onlyNeedsLocal = specifier.local.name === exported

						specifiers +=
							(onlyNeedsLocal
								? specifier.local.name
								: `${exported}: ${specifier.local.name}`) + ','
					}

					const external = !!node.source

					exports += external
						? `...{ ${specifiers} } = importModule('${this.resolveRequest(
								node.source.value,
						  )}'),`
						: specifiers
				}
			} else if (node.type === 'ExportDefaultDeclaration') {
				this.ast.body.pop(index)

				exports += `default: ${
					toJs(
						{
							type: 'Program',
							body: [node.declaration],
							sourceType: 'module',
						},
						{ handlers: jsx },
					).value
				},`
			} else if (node.type === 'ExportAllDeclaration') {
				this.ast.body.pop(index)

				const exported =
					node.exported?.name ??
					(node.exported?.value && `'${node.exported?.value}'`)

				exports += `${
					node.exported ? `${exported}: ` : '...'
				}importModule('${this.resolveRequest(node.source.value)}'),`
			}
		}

		this.ast.body.push(
			fromJs(`return {${exports}}`, {
				allowReturnOutsideFunction: true,
				plugins: [JSXPlugin(), stage3Plugin],
			}).body[0],
		)

		this.content = toJs(this.ast, { handlers: JSXHandler }).value
	}
}

const URLToString = <T>(maybeURL: T): T extends URL ? string : T =>
	// @ts-ignore ?
	maybeURL instanceof URL ? maybeURL.href : maybeURL

async function createDependencyGraph(
	filepath: Location,
	moduleCache: ModuleCache,
) {
	const rootModule = await new Module(filepath, moduleCache)
	return rootModule
}

function collectModules(graph: Module) {
	const modules = new Set<Module>()
	collect(graph, modules)

	function collect(module: Module, modules: Set<Module>) {
		if (!modules.has(module)) {
			modules.add(module)

			module.dependencies.forEach(dependency =>
				collect(dependency, modules),
			)
		}
	}

	return Array.from(modules)
}

function toModuleMap(modules: Module[]) {
	let moduleMap = ''
	moduleMap += '{\n'

	for (const module of modules) {
		module.transformModuleInterface()
		moduleMap += `"${module.filepath}"() {${module.content} },`
	}

	moduleMap += '}'

	return moduleMap
}

export async function pack(filepath: Location) {
	const moduleCache: ModuleCache = new Map()
	const base: string = ErrorStackParser.parse(new Error())[0].fileName
	const absoluteFilepath = new URL(filepath, base)
	const graph = await createDependencyGraph(absoluteFilepath, moduleCache)
	const collectedModules = collectModules(graph)
	const moduleMap = toModuleMap(collectedModules)

	const template = `const EXPORTS_CACHE = new Map()
    const MODULES = ${moduleMap}

    function importModule(moduleName) {
        if (!EXPORTS_CACHE.has(moduleName)) {
        	EXPORTS_CACHE.set(moduleName, MODULES[moduleName]())
        }

        return EXPORTS_CACHE.get(moduleName)
    }
    
    MODULES['${URLToString(absoluteFilepath)}']()`

	return template
}

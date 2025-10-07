require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { TableClient, TableServiceClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");
const multer = require('multer');
const path = require('path');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());


let azureInitialized = false;
let containerClient, tabelaVeiculos, tabelaClientes, tabelaLocacoes;

// ----------------------------
// Funções de inicialização do Azure
// ----------------------------
async function inicializarAzure() {
    if (azureInitialized) return;
    
    try {
        console.log("Inicializando recursos Azure...");
        
        // Inicializar Blob Storage
        const blobService = new BlobServiceClient(`${process.env.BLOB_URL}`);
        containerClient = blobService.getContainerClient(process.env.BLOB_CONTAINER);
        
        const containerExists = await containerClient.exists();
        if (!containerExists) {
            await containerClient.create();
            console.log('Container criado:', process.env.BLOB_CONTAINER);
        } else {
            console.log('Container já existe:', process.env.BLOB_CONTAINER);
        }

        // Inicializar Table Storage
        const serviceClient = new TableServiceClient(`${process.env.TABLE_URL}`);
        
        const tabelas = [
            process.env.VEHICLE_TABLE,
            process.env.CLIENT_TABLE,
            process.env.RENTAL_TABLE
        ];
        
        for (const t of tabelas) {
            try {
                await serviceClient.createTable(t);
                console.log('Tabela criada:', t);
            } catch (err) {
                if (err.statusCode === 409) {
                    console.log('Tabela já existe:', t);
                } else {
                    console.error('Erro criando tabela', t, err.message);
                }
            }
        }

        // Inicializar clients das tabelas
        tabelaVeiculos = new TableClient(`${process.env.TABLE_URL}`, process.env.VEHICLE_TABLE);
        tabelaClientes = new TableClient(`${process.env.TABLE_URL}`, process.env.CLIENT_TABLE);
        tabelaLocacoes = new TableClient(`${process.env.TABLE_URL}`, process.env.RENTAL_TABLE);

        azureInitialized = true;
        console.log("Recursos Azure inicializados com sucesso.");
        
    } catch (err) {
        console.error("Erro crítico ao inicializar Azure:", err.message);
        throw err;
    }
}

// ----------------------------
// Middleware para garantir inicialização do Azure
// ----------------------------
app.use(async (req, res, next) => {
    try {
        if (!azureInitialized) {
            await inicializarAzure();
        }
        next();
    } catch (err) {
        console.error('Erro na inicialização do Azure:', err);
        res.status(500).json({ 
            error: 'Serviço temporariamente indisponível',
            detalhes: err.message 
        });
    }
});

// ----------------------------
// Configuração do Multer
// ----------------------------
const upload = multer({ storage: multer.memoryStorage() });

function normalizarNomeArquivo(nome) {
    return nome.replace(/[^a-zA-Z0-9\-_.]/g, '_');
}

// ----------------------------
// Rotas de Upload
// ----------------------------
app.post('/upload-veiculo', upload.single('imagem'), async (req, res) => {
    try {
        const nomeArquivo = normalizarNomeArquivo(req.file.originalname);
        const blockBlobClient = containerClient.getBlockBlobClient(nomeArquivo);
        await blockBlobClient.uploadData(req.file.buffer);
        res.json({ url: blockBlobClient.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------
// Rotas de Veículos
// ----------------------------
app.post('/veiculos', upload.single('imagem'), async (req, res) => {
    try {
        let urlImagem = '';
        if (req.file) {
            const nomeArquivo = normalizarNomeArquivo(req.file.originalname);
            const blockBlobClient = containerClient.getBlockBlobClient(nomeArquivo);
            await blockBlobClient.uploadData(req.file.buffer);
            urlImagem = blockBlobClient.url;
        }

        const { marca, modelo, ano, placa, precoDiaria, disponivel } = req.body;

        await tabelaVeiculos.createEntity({
            partitionKey: 'Veiculo',
            rowKey: placa,
            marca: marca,
            modelo: modelo,
            ano: parseInt(ano),
            urlImagem,
            precoDiaria: parseFloat(precoDiaria),
            disponivel: disponivel === 'true' || disponivel === true
        });

        res.json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao cadastrar veículo:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/veiculos/disponiveis', async (req, res) => {
    try {
        const { marca, modelo } = req.query;
        const iter = tabelaVeiculos.listEntities({
            queryOptions: { filter: `disponivel eq true` }
        });
        const veiculos = [];

        for await (const v of iter) {
            if ((!marca || v.marca === marca) && (!modelo || v.modelo === modelo)) {
                veiculos.push({
                    marca: v.marca,
                    modelo: v.modelo,
                    ano: v.ano,
                    urlImagem: v.urlImagem,
                    placa: v.rowKey,
                    precoDiaria: v.precoDiaria,
                    disponivel: v.disponivel
                });
            }
        }
        res.json(veiculos);
    } catch (err) {
        console.error('Erro ao buscar veículos disponíveis:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/modelos/:marca', async (req, res) => {
    try {
        const marca = req.params.marca;
        const iter = tabelaVeiculos.listEntities();
        const modelos = new Set();

        for await (const v of iter) {
            if (v.marca === marca) modelos.add(v.modelo);
        }

        res.json(Array.from(modelos));
    } catch (err) {
        console.error('Erro ao buscar modelos:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/marcas', async (req, res) => {
    try {
        const iter = tabelaVeiculos.listEntities();
        const marcas = new Set();

        for await (const v of iter) {
            if (v.marca) marcas.add(v.marca);
        }

        res.json(Array.from(marcas));
    } catch (err) {
        console.error('Erro ao buscar marcas:', err);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------
// Rotas de Clientes
// ----------------------------
app.post('/clientes', async (req, res) => {
    try {
        const { nome, email, telefone } = req.body;

        await tabelaClientes.createEntity({
            partitionKey: 'Cliente',
            rowKey: Date.now().toString(),
            nome,
            email,
            telefone
        });

        res.json({ sucesso: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/clientes', async (req, res) => {
    try {
        const iter = tabelaClientes.listEntities();
        const clientes = [];
        for await (const c of iter) clientes.push(c);
        res.json(clientes);
    } catch (err) {
        console.error('Erro ao buscar clientes:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, email, telefone } = req.body;

        const cliente = await tabelaClientes.getEntity("Cliente", id);
        await tabelaClientes.updateEntity({
            partitionKey: cliente.partitionKey,
            rowKey: cliente.rowKey,
            nome,
            email,
            telefone
        }, "Merge");

        res.json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao atualizar cliente:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/clientes/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const cliente = await tabelaClientes.getEntity("Cliente", id);

        const locacoesIter = tabelaLocacoes.listEntities();
        let temLocacoesAtivas = false;

        for await (const locacao of locacoesIter) {
            if (locacao.clienteId === id && locacao.status === "ativa") {
                temLocacoesAtivas = true;
                break;
            }
        }

        if (temLocacoesAtivas) {
            return res.status(400).json({
                sucesso: false,
                mensagem: 'Não é possível excluir cliente com locações ativas'
            });
        }

        await tabelaClientes.deleteEntity("Cliente", id);

        res.json({
            sucesso: true,
            mensagem: 'Cliente excluído com sucesso'
        });
    } catch (err) {
        console.error('Erro ao excluir cliente:', err);

        if (err.statusCode === 404) {
            return res.status(404).json({
                sucesso: false,
                mensagem: 'Cliente não encontrado'
            });
        }

        res.status(500).json({
            sucesso: false,
            mensagem: err.message
        });
    }
});

// ----------------------------
// Rotas de Locações
// ----------------------------
app.post('/locacoes', async (req, res) => {
    try {
        const { placaVeiculo, clienteId, dataInicio, dataFim, valor } = req.body;

        if (!placaVeiculo || !clienteId) {
            return res.status(400).json({ sucesso: false, mensagem: 'Campos obrigatórios ausentes.' });
        }

        let veiculo = null;
        try {
            veiculo = await tabelaVeiculos.getEntity('Veiculo', placaVeiculo);
        } catch (err) {
            console.log('Veículo não encontrado:', err.message);
        }

        const entidade = {
            partitionKey: 'Locacao',
            rowKey: Date.now().toString(),
            placaVeiculo,
            marca: veiculo?.marca || '---',
            modelo: veiculo?.modelo || '---',
            clienteId,
            dataInicio,
            dataFim,
            valor: parseFloat(valor),
            status: 'ativa'
        };

        await tabelaLocacoes.createEntity(entidade);

        if (veiculo) {
            await tabelaVeiculos.updateEntity({
                partitionKey: veiculo.partitionKey,
                rowKey: veiculo.rowKey,
                disponivel: false
            }, "Merge");
        }

        res.json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao criar locação:', err);
        res.status(500).json({ sucesso: false, mensagem: err.message });
    }
});

app.post('/cancelar-locacao', async (req, res) => {
    try {
        const { locacaoId } = req.body;
        const locacao = await tabelaLocacoes.getEntity("Locacao", locacaoId);
        await tabelaLocacoes.updateEntity({
            partitionKey: locacao.partitionKey,
            rowKey: locacao.rowKey,
            status: "cancelada"
        }, "Merge");

        if (locacao.placaVeiculo) {
            try {
                const veiculo = await tabelaVeiculos.getEntity('Veiculo', locacao.placaVeiculo);
                await tabelaVeiculos.updateEntity({
                    partitionKey: veiculo.partitionKey,
                    rowKey: veiculo.rowKey,
                    disponivel: true
                }, "Merge");
            } catch (err) {
                console.log('Veículo não encontrado para cancelamento:', err.message);
            }
        }

        res.json({ sucesso: true });
    } catch (err) {
        console.error('Erro ao cancelar locação:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/veiculos/alugados', async (req, res) => {
    try {
        const locacoesAtivas = [];
        for await (const l of tabelaLocacoes.listEntities()) {
            if (l.status === "ativa") {
                let veiculo = null;
                let cliente = null;

                try {
                    veiculo = await tabelaVeiculos.getEntity('Veiculo', l.placaVeiculo);
                } catch (err) {
                    console.log('Veículo não encontrado:', l.placaVeiculo);
                }

                try {
                    cliente = await tabelaClientes.getEntity('Cliente', l.clienteId);
                } catch (err) {
                    console.log('Cliente não encontrado:', l.clienteId);
                }

                locacoesAtivas.push({
                    id: l.rowKey,
                    dataInicio: l.dataInicio,
                    dataFim: l.dataFim,
                    status: l.status,
                    valorTotal: l.valor,
                    veiculo: veiculo ? {
                        marca: veiculo.marca,
                        modelo: veiculo.modelo,
                        ano: veiculo.ano,
                        precoDiaria: veiculo.precoDiaria,
                        urlImagem: veiculo.urlImagem,
                        placa: veiculo.rowKey
                    } : null,
                    cliente: cliente ? {
                        nome: cliente.nome,
                        email: cliente.email,
                        telefone: cliente.telefone,
                        id: cliente.rowKey
                    } : null
                });
            }
        }
        res.json(locacoesAtivas);
    } catch (err) {
        console.error("Erro ao buscar alugados:", err);
        res.status(500).json({ error: err.message });
    }
});

// ----------------------------
// Health Check para testar inicialização
// ----------------------------
app.get('/health', async (req, res) => {
    try {
        if (!azureInitialized) {
            await inicializarAzure();
        }
        res.json({ 
            status: 'healthy', 
            azureInitialized: azureInitialized,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: err.message 
        });
    }
});



const PORT = process.env.PORT || 3000;

// Roda localmente apenas se executado diretamente
if (require.main === module) {
    app.listen(PORT, () => console.log(`Servidor rodando localmente na porta ${PORT}`));
}

// Exporta app adaptado para Vercel
module.exports = serverless(app);
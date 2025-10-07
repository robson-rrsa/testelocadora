require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { TableClient, TableServiceClient } = require("@azure/data-tables");
const { BlobServiceClient } = require("@azure/storage-blob");
const multer = require('multer');
const serverless = require('serverless-http');

const app = express();
app.use(cors());
app.use(express.json());

// ====================
// CONFIGURAÇÃO DAS ROTAS DO FRONTEND
// ====================

// Rota principal que serve o index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota para a página de administração
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ====================
// AZURE SERVERLESS-SAFE INITIALIZATION
// ====================

async function getAzureClients() {
    const blobService = new BlobServiceClient(`${process.env.BLOB_URL}`);
    const containerClient = blobService.getContainerClient(process.env.BLOB_CONTAINER);
    
    const containerExists = await containerClient.exists();
    if (!containerExists) {
        await containerClient.create();
        console.log('Container criado:', process.env.BLOB_CONTAINER);
    }

    const serviceClient = new TableServiceClient(`${process.env.TABLE_URL}`);

    // Criar tabelas se não existirem
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

    const tabelaVeiculos = new TableClient(`${process.env.TABLE_URL}`, process.env.VEHICLE_TABLE);
    const tabelaClientes = new TableClient(`${process.env.TABLE_URL}`, process.env.CLIENT_TABLE);
    const tabelaLocacoes = new TableClient(`${process.env.TABLE_URL}`, process.env.RENTAL_TABLE);

    return { containerClient, tabelaVeiculos, tabelaClientes, tabelaLocacoes };
}

// ====================
// ROTAS DA API
// ====================

const upload = multer({ storage: multer.memoryStorage() });

function normalizarNomeArquivo(nome) {
    return nome.replace(/[^a-zA-Z0-9\-_.]/g, '_');
}

app.post('/upload-veiculo', upload.single('imagem'), async (req, res) => {
    try {
        const { containerClient } = await getAzureClients();
        const nomeArquivo = normalizarNomeArquivo(req.file.originalname);
        const blockBlobClient = containerClient.getBlockBlobClient(nomeArquivo);
        await blockBlobClient.uploadData(req.file.buffer);
        res.json({ url: blockBlobClient.url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/veiculos', upload.single('imagem'), async (req, res) => {
    try {
        const { containerClient, tabelaVeiculos } = await getAzureClients();
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
            marca,
            modelo,
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

app.post('/clientes', async (req, res) => {
    try {
        const { tabelaClientes } = await getAzureClients();
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
        const { tabelaClientes } = await getAzureClients();
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
        const { tabelaClientes } = await getAzureClients();

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

app.get('/veiculos/disponiveis', async (req, res) => {
    try {
        const { marca, modelo } = req.query;
        const { tabelaVeiculos } = await getAzureClients();
        const iter = tabelaVeiculos.listEntities({ queryOptions: { filter: `disponivel eq true` } });
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
        const { tabelaVeiculos } = await getAzureClients();
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
        const { tabelaVeiculos } = await getAzureClients();
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

// ... Mantenha todas as outras rotas da API iguais,
// apenas substituindo as variáveis globais pelo await getAzureClients()

// ====================
// CONFIGURAÇÃO FINAL DO SERVIDOR
// ====================

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => console.log(`Servidor rodando localmente na porta ${PORT}`));
}

module.exports = serverless(app);

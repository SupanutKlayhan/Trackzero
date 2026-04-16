const { timeStamp } = require('console');
const express = require('express');
const path = require('path');
const port =3300;
const app = express();
app.use(express.static(path.join(__dirname, 'html')));
const router = express.Router();
router.use(express.json());
router.use(express.urlencoded({ extended: true }));
app.use(router);

router.get('/',(req,res) =>{
    console.log(`Request at: ${req.url}`);
    res.sendFile(path.join(`${__dirname}/html/Home.html`));
})
router.get('/Login', (req, res) => {
    console.log('Req: /Login');
    console.log('Retrieve a form');
    res.sendFile(path.join(`${__dirname}/html/Login.html`));
});

router.get('/Team', (req, res) => {
    console.log('Request at /Team');
    res.sendFile(path.join(`${__dirname}/html/Team.html`));
});
router.get('/Search', (req, res) => {
    console.log('Request at /Search');
    res.sendFile(path.join(`${__dirname}/html/Search.html`));
    
});
router.get('/Manage-Products', (req, res) => {
    console.log('Request at /Manage-Products');
    res.sendFile(path.join(`${__dirname}/html/productservice-management.html`));
});
router.get('/Detail', (req, res) => {
    console.log('Request at /Detail');
    res.sendFile(path.join(`${__dirname}/html/Detail.html`));
});
app.listen(port, () => {
console.log(`Server listening on port: ${port}`)
});